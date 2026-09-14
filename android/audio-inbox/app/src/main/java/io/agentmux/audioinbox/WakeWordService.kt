package io.agentmux.audioinbox

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager
import io.agentmux.wakeword.EndpointPolicy
import io.agentmux.wakeword.OnnxFloatModel
import io.agentmux.wakeword.SileroSpeechProbability
import io.agentmux.wakeword.TurnProgress
import io.agentmux.wakeword.TurnStage
import io.agentmux.wakeword.UtteranceEnd
import io.agentmux.wakeword.WAKE_SAMPLE_RATE
import io.agentmux.wakeword.WakeEvent
import io.agentmux.wakeword.WakePhase
import io.agentmux.wakeword.WakeWordDetector
import io.agentmux.wakeword.WakeWordModels
import io.agentmux.wakeword.listensForWakeWord
import io.agentmux.linkui.LinkWakePhrase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

private const val THINKING_TONE_LIMIT_MS = 30_000L

/**
 * WHAT: Foreground microphone service for hands-free Link: the wake phrase, a question, a spoken answer, a follow-up.
 * WHY: Questions go through the same process-wide conversation owner as push-to-talk,
 * so they work with the screen locked and appear in the normal history.
 */
class WakeWordService : Service(), WakeLoopListener {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val encoder = Executors.newSingleThreadExecutor()
    private var coordinator: LinkCoordinator? = null
    private var loop: WakeListeningLoop? = null
    private var micThread: Thread? = null
    private var earcons: WakeEarcons? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var thinkingTones: Job? = null
    private val readAloudRequested = mutableSetOf<String>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> start(intent.getStringExtra(EXTRA_QA_WAV))
            ACTION_STOP -> {
                // Stop from the notification means off, so reopening Link does not restart listening.
                getSharedPreferences(AppContract.PREFS, MODE_PRIVATE).edit().putBoolean(KEY_WAKE_WORD, false).apply()
                stop(null)
            }
            // A system restart of a microphone service is not user-visible; say so instead of listening blind.
            else -> stop("Open Link to start listening again")
        }
        return START_NOT_STICKY
    }

    private fun start(qaWav: String?) {
        if (micThread != null) return
        val status = LinkWakeStatus.apply(WakeEvent.Start)
        try {
            startForeground(WAKE_NOTIFICATION_ID, WakeNotifications.build(this, status), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } catch (error: RuntimeException) {
            stop("Android refused the microphone service · ${error.message.orEmpty().take(80)}")
            return
        }
        val held = LinkRuntime.acquire(this).also { coordinator = it }
        earcons = WakeEarcons()
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "agentmux-link:wake-word").apply { acquire() }
        observeStatus()
        observeTurns(held)
        micThread = Thread({ listen(qaWav) }, "link-wake-word").apply { start() }
    }

    private fun listen(qaWav: String?) {
        try {
            openModels().use { models ->
                SileroSpeechProbability.load(assetBytes("silero_vad.onnx")).use { vad ->
                    openSource(qaWav).use { source ->
                        WakeListeningLoop(
                            source = source,
                            detector = WakeWordDetector(models),
                            vad = vad,
                            threshold = LinkWakePhrase.threshold,
                            policy = EndpointPolicy(),
                            detectionAllowed = { LinkWakeStatus.status.value.listensForWakeWord() },
                            followUpWindow = { LinkWakeStatus.status.value.takeIf { it.phase == WakePhase.FOLLOW_UP }?.followUps },
                            followUpPolicy = EndpointPolicy(waitForSpeechMs = 4_000),
                            listener = this,
                        ).also { loop = it }.run()
                    }
                }
            }
        } catch (error: WakeSourceUnavailable) {
            MainThread.run { stop(error.message) }
        } catch (error: Exception) {
            MainThread.run { stop("Wake word failed · ${error.message.orEmpty().take(100)}") }
        }
    }

    private fun openModels() = WakeWordModels(
        melspectrogram = OnnxFloatModel.load(assetBytes("melspectrogram.onnx")),
        embedding = OnnxFloatModel.load(assetBytes("embedding_model.onnx")),
        classifier = OnnxFloatModel.load(assetBytes(LinkWakePhrase.modelAsset)),
    )

    private fun openSource(qaWav: String?): WakePcmSource =
        if (BuildConfig.DEBUG && qaWav != null) {
            WavFixturePcmSource(qaWav) { LinkWakeStatus.status.value.phase }
        } else {
            MicrophonePcmSource.open(this)
        }

    private fun assetBytes(name: String): ByteArray = assets.open(name).use { it.readBytes() }

    override fun onDetected(score: Float) = MainThread.run {
        val interrupted = LinkWakeStatus.status.value.phase == WakePhase.SPEAKING
        LinkWakeStatus.apply(WakeEvent.Detected(score))
        if (interrupted) coordinator?.stopAudio()
        earcons?.heard()
    }

    override fun onQuestion(end: UtteranceEnd, pcm: ShortArray, startedAtMs: Long) {
        if (end == UtteranceEnd.NO_SPEECH) {
            MainThread.run {
                val afterWakePhrase = LinkWakeStatus.status.value.phase == WakePhase.CAPTURING
                LinkWakeStatus.apply(WakeEvent.CaptureEnded(end, null))
                if (afterWakePhrase) earcons?.failed()
            }
            return
        }
        encoder.execute {
            val turnId = UUID.randomUUID().toString()
            val file = File(cacheDir, "wake-$turnId.m4a")
            val encoded = runCatching { PcmAacEncoder.encode(pcm, WAKE_SAMPLE_RATE, file) }
            MainThread.run { submit(end, PushToTalkRecorder.Capture(turnId, file, startedAtMs), encoded.exceptionOrNull()) }
        }
    }

    private fun submit(end: UtteranceEnd, capture: PushToTalkRecorder.Capture, encodingError: Throwable?) {
        val held = coordinator ?: return
        val failure = when {
            encodingError != null -> "Could not encode the question · ${encodingError.message.orEmpty().take(80)}"
            held.selectedTarget() == null -> "No target selected in Link"
            !held.submitAudio(capture, handsFree = true) -> "The selected target is unavailable"
            else -> null
        }
        if (failure != null) capture.file.delete()
        LinkWakeStatus.apply(WakeEvent.CaptureEnded(end, capture.turnId.takeIf { failure == null }, failure ?: ""))
        if (failure == null) earcons?.sent() else earcons?.failed()
    }

    override fun onSourceStopped() = MainThread.run { stop("The microphone stopped delivering audio") }

    private fun observeTurns(held: LinkCoordinator) = scope.launch {
        held.state.collect { state ->
            val tracked = LinkWakeStatus.status.value.turnId ?: return@collect
            val turn = state.turns.firstOrNull { it.turnId == tracked }
            if (turn != null && turn.awaitsReadAloud() && readAloudRequested.add(tracked)) {
                readAloud(held, tracked)
            }
            LinkWakeStatus.apply(WakeEvent.TurnChanged(turn.wakeProgress()))
        }
    }

    /** Starting playback from the background is refused unless Link is exempt from battery optimization. */
    private fun readAloud(held: LinkCoordinator, turnId: String) {
        runCatching { held.playReply(turnId, explicitReplay = false) }.onFailure { error ->
            val reason = if (wakeBatteryRestricted(this)) "set Link's battery use to Unrestricted" else error.message.orEmpty()
            LinkWakeStatus.apply(WakeEvent.TurnChanged(TurnProgress(TurnStage.SPEAK_FAILED, reason.take(100))))
            earcons?.failed()
        }
    }

    private fun observeStatus() {
        scope.launch {
            LinkWakeStatus.status.collect { status ->
                if (micThread != null) WakeNotifications.update(this@WakeWordService, status)
            }
        }
        scope.launch {
            LinkWakeStatus.status.map { it.phase }.distinctUntilChanged().collect { phase ->
                thinkingTones?.cancel()
                if (phase == WakePhase.THINKING) thinkingTones = launch { tickWhileThinking() }
                if (phase == WakePhase.FOLLOW_UP) earcons?.followUp()
            }
        }
    }

    private suspend fun tickWhileThinking() {
        delay(2_000)
        var waited = 2_000L
        while (waited < THINKING_TONE_LIMIT_MS) {
            earcons?.thinking()
            delay(3_000)
            waited += 3_000
        }
    }

    private fun stop(reason: String?) {
        loop?.stop()
        micThread?.let { if (it !== Thread.currentThread()) it.join(1_000) }
        micThread = null
        loop = null
        thinkingTones?.cancel()
        LinkWakeStatus.apply(if (reason == null) WakeEvent.Stop else WakeEvent.Blocked(reason))
        earcons?.close()
        earcons = null
        wakeLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
        coordinator?.let(LinkRuntime::release)
        coordinator = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        if (micThread != null) stop(null)
        scope.cancel()
        encoder.shutdown()
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "io.agentmux.audioinbox.WAKE_START"
        const val ACTION_STOP = "io.agentmux.audioinbox.WAKE_STOP"
        const val EXTRA_QA_WAV = "qa_wake_wav"
    }
}
