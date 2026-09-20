package io.agentmux.audioinbox

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager
import io.agentmux.wakeword.EndpointPolicy
import io.agentmux.wakeword.OnnxFloatModel
import io.agentmux.wakeword.SileroSpeechProbability
import io.agentmux.wakeword.SpeechChunkProbability
import io.agentmux.wakeword.TurnProgress
import io.agentmux.wakeword.TurnStage
import io.agentmux.wakeword.UtteranceEnd
import io.agentmux.wakeword.WAKE_SAMPLE_RATE
import io.agentmux.wakeword.WakeChunkScorer
import io.agentmux.wakeword.WakeEvent
import io.agentmux.wakeword.WakeHearing
import io.agentmux.wakeword.WakeListeningLoop
import io.agentmux.wakeword.WakeLoopListener
import io.agentmux.wakeword.WakePcmSource
import io.agentmux.wakeword.WakePhrase
import io.agentmux.wakeword.WakePhase
import io.agentmux.wakeword.WakeStatus
import io.agentmux.wakeword.WakeWordDetector
import io.agentmux.wakeword.WakeWordModels
import io.agentmux.wakeword.listensForWakeWord
import io.agentmux.wakeword.questionCancellable
import io.agentmux.wakeword.acceptsCapture
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import io.agentmux.linkui.AndroidLinkListeningCue

private const val THINKING_TONE_LIMIT_MS = 30_000L

/**
 * WHAT: Builds Link's foreground hands-free microphone loop.
 * WHY: Keeps wake questions on the same conversation path as push-to-talk.
 */
class WakeWordService : Service(), WakeLoopListener {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val encoder = Executors.newSingleThreadExecutor()
    private var coordinator: LinkCoordinator? = null
    private var loop: WakeListeningLoop? = null
    private var micThread: Thread? = null
    private var earcons: WakeEarcons? = null
    private var listeningCue: AndroidLinkListeningCue? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var thinkingTones: Job? = null
    private val readAloudRequested = mutableSetOf<String>()
    private var qaWav: String? = null
    /** True only when the TRY page started the loop itself, which is what leaving it has to undo. */
    private var startedForTry = false
    /**
     * The newest start Android has given this service. A stop quotes it, so a start that arrives while
     * the stop is being carried out keeps the service alive instead of being dropped with it: the page
     * can be left and opened again in the same second, and the TRY page's own start asks for the
     * foreground, which Android kills the app for not keeping.
     */
    private var lastStartId = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        lastStartId = startId
        when (intent?.action) {
            ACTION_START -> start(intent.getStringExtra(EXTRA_QA_WAV))
            ACTION_CANCEL_QUESTION -> cancelQuestion()
            ACTION_TRY_OPEN -> openForTry()
            ACTION_TRY_CLOSE -> closeForTry()
            // Watching is read when the loop opens, so turning it on or off reopens it.
            ACTION_RELISTEN -> if (micThread != null) relisten()
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

    private fun start(qaWav: String?, cueWhenOpen: Boolean = false) {
        if (micThread != null) {
            // Already listening, and this start still has to post a notification: every start that asked
            // for the foreground must, and Android kills the app five seconds later if one does not.
            goForeground(LinkWakeStatus.status.value)
            // A QA clip handed to a loop that is already listening becomes what it reads, so a proof can
            // play something through a page that is open without stopping the loop under it first. The
            // microphone is the only source a release build ever opens.
            if (BuildConfig.DEBUG && qaWav != null) {
                this.qaWav = qaWav
                relisten()
            }
            return
        }
        this.qaWav = qaWav
        LinkWakePhraseChoice.restore(this)
        val status = LinkWakeStatus.apply(WakeEvent.Start)
        if (!goForeground(status)) return
        val held = LinkRuntime.acquire(this).also { coordinator = it }
        earcons = WakeEarcons()
        listeningCue = AndroidLinkListeningCue(this) { LinkListeningSoundPreference.isEnabled(this) }
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "agentmux-link:wake-word").apply { acquire() }
        observeStatus()
        observeTurns(held)
        startListening(cueWhenOpen)
    }

    private fun startListening(cueWhenOpen: Boolean = false) {
        val phrase = LinkWakeStatus.status.value.phrase
        micThread = Thread({ listen(phrase, qaWav, cueWhenOpen) }, "link-wake-word").apply { start() }
    }

    /** A new phrase needs its own model: the microphone loop closes and opens again with it. */
    private fun relisten(cueWhenOpen: Boolean = false) {
        if (micThread == null) return
        loop?.stop()
        micThread?.join(1_000)
        loop = null
        startListening(cueWhenOpen)
    }

    private fun listen(phrase: WakePhrase, qaWav: String?, cueWhenOpen: Boolean) {
        val sensitivity = LinkWakeStatus.status.value.sensitivity
        try {
            openModels(phrase).use { models ->
                SileroSpeechProbability.load(assetBytes("silero_vad.onnx")).use { vad ->
                    openSource(qaWav).use { source ->
                        if (cueWhenOpen) MainThread.run { listeningCue?.listeningStarted() }
                        val detector = WakeWordDetector(models)
                        WakeListeningLoop(
                            source = source,
                            detector = object : WakeChunkScorer {
                                override fun score(chunk: ShortArray) = detector.score(chunk)
                                override fun reset() = detector.reset()
                            },
                            vad = object : SpeechChunkProbability {
                                override fun probability(chunk: ShortArray) = vad.probability(chunk)
                                override fun reset() = vad.reset()
                            },
                            // The wearer's step moves the phrase's own measured threshold and says how
                            // many chunks must agree; both are read here, when the loop opens.
                            threshold = sensitivity.thresholdFor(phrase),
                            endpoint = EndpointPolicy(),
                            detection = sensitivity.detection,
                            detectionAllowed = { LinkWakeStatus.status.value.listensForWakeWord() },
                            // Row 217: while the TRY page is open the loop judges and reports and is
                            // never allowed to ask, so the utterance reaches the page whole.
                            questionsAllowed = { !LinkWakeTry.open.value },
                            listener = this,
                            // Null unless the TRY page is open or the wearer switched watching on in
                            // WAKE DEBUG: with a trace the loop asks the speech model about every
                            // waiting chunk as well, which is why nobody gets one for free.
                            trace = wakeChunkWatchers(),
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

    private fun openModels(phrase: WakePhrase) = WakeWordModels(
        melspectrogram = OnnxFloatModel.load(assetBytes("melspectrogram.onnx")),
        embedding = OnnxFloatModel.load(assetBytes("embedding_model.onnx")),
        classifier = OnnxFloatModel.load(assetBytes(phrase.modelAsset)),
    )

    private fun openSource(qaWav: String?): WakePcmSource =
        if (BuildConfig.DEBUG && qaWav != null) {
            WavFixturePcmSource(qaWav) { LinkWakeStatus.status.value.phase }
        } else {
            MicrophonePcmSource.open(this)
        }

    private fun assetBytes(name: String): ByteArray = assets.open(name).use { it.readBytes() }

    override fun onDetected(score: Float) {
        // Row 217. While the TRY page is open the loop may not ask a question at all, so this is only
        // reached if that wiring is ever wrong. Nothing is what the page promises, and nothing is what
        // happens here: no phase changes, so no ring, no earcon, and no notification says Link is
        // hearing a question. Dropping one after the fact is what must not be done; it resets the
        // detector and takes the rest of the phrase with it.
        if (LinkWakeTry.open.value) return
        MainThread.run {
            val interrupted = LinkWakeStatus.status.value.phase == WakePhase.SPEAKING
            LinkWakeStatus.apply(WakeEvent.Detected(score))
            if (interrupted) coordinator?.stopAudio()
            listeningCue?.listeningStarted()
        }
    }

    /** Nothing is captured while the page is open, and a chunk of one is still not the page's. */
    override fun onHearing(hearing: WakeHearing) {
        if (LinkWakeTry.open.value) return
        MainThread.run { LinkWakeStatus.apply(WakeEvent.Heard(hearing)) }
    }

    /**
     * Posts the one microphone notification, and says whether Android allowed it. Every foreground start
     * lands here: measured on a device 2026-09-19, a second foreground start that reopened the loop
     * without posting one had the app killed by
     * `ForegroundServiceDidNotStartInTimeException` five seconds later.
     */
    private fun goForeground(status: WakeStatus): Boolean = try {
        ServiceCompat.startForeground(
            this, WAKE_NOTIFICATION_ID, WakeNotifications.build(this, status),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
        )
        true
    } catch (error: RuntimeException) {
        stop("Android refused the microphone service · ${error.message.orEmpty().take(80)}")
        false
    }

    /**
     * The TRY page is on screen. The loop reopens so it reports every chunk to the page's recorder, and
     * it starts here when the wake word is off: the page listens for as long as it is open and says so.
     */
    private fun openForTry() {
        if (micThread == null) {
            startedForTry = true
            start(null, cueWhenOpen = true)
            return
        }
        goForeground(LinkWakeStatus.status.value)
        relisten(cueWhenOpen = true)
    }

    /** The page is gone: the loop goes back to what it was, which is off when the page started it. */
    private fun closeForTry() {
        if (micThread == null) {
            // Whatever was listening has already stopped; this service has nothing left to hold open.
            startedForTry = false
            stopSelf()
            return
        }
        if (startedForTry) {
            startedForTry = false
            stop(null)
            return
        }
        relisten()
    }

    /** The talk ring was tapped while a question was heard: drop it before anything is encoded or sent. */
    private fun cancelQuestion() {
        if (!LinkWakeStatus.status.value.questionCancellable()) return
        loop?.cancelQuestion()
        LinkWakeStatus.apply(WakeEvent.QuestionCancelled)
        earcons?.failed()
    }

    override fun onQuestion(end: UtteranceEnd, pcm: ShortArray, startedAtMs: Long) {
        // The one seam a question can come into being at, and the TRY page's promise is that none does
        // while it is open. The loop is told not to start one, so this cannot normally be reached; the
        // promise is not left resting on one parameter being passed.
        if (LinkWakeTry.open.value) return
        val detection = LinkWakeStatus.status.value.detections
        if (end == UtteranceEnd.NO_SPEECH) {
            MainThread.run {
                val afterWakePhrase = LinkWakeStatus.status.value.acceptsCapture(detection)
                LinkWakeStatus.apply(WakeEvent.CaptureEnded(end, null, detection))
                if (afterWakePhrase) earcons?.failed()
            }
            return
        }
        encoder.execute {
            val turnId = UUID.randomUUID().toString()
            val file = File(cacheDir, "wake-$turnId.m4a")
            val encoded = runCatching { PcmAacEncoder.encode(pcm, WAKE_SAMPLE_RATE, file) }
            MainThread.run { submit(end, PushToTalkRecorder.Capture(turnId, file, startedAtMs), detection, encoded.exceptionOrNull()) }
        }
    }

    private fun submit(end: UtteranceEnd, capture: PushToTalkRecorder.Capture, detection: Int, encodingError: Throwable?) {
        val held = coordinator
        // Cancelled while it was being encoded: the question never becomes a turn.
        if (held == null || !LinkWakeStatus.status.value.acceptsCapture(detection)) {
            capture.file.delete()
            return
        }
        val failure = when {
            encodingError != null -> "Could not encode the question · ${encodingError.message.orEmpty().take(80)}"
            held.selectedTarget() == null -> "No target selected in Link"
            !held.submitAudio(capture, handsFree = true) -> "The selected target is unavailable"
            else -> null
        }
        if (failure != null) capture.file.delete()
        LinkWakeStatus.apply(WakeEvent.CaptureEnded(end, capture.turnId.takeIf { failure == null }, detection, failure ?: ""))
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
            // The voice level changes 12 times a second; the notification only needs the phase and detail.
            LinkWakeStatus.status.map { it.copy(hearing = null) }.distinctUntilChanged().collect { status ->
                if (micThread != null) WakeNotifications.update(this@WakeWordService, status)
            }
        }
        scope.launch {
            LinkWakeStatus.status.map { it.phrase }.distinctUntilChanged().drop(1).collect { relisten() }
        }
        scope.launch {
            LinkWakeStatus.status.map { it.phase }.distinctUntilChanged().collect { phase ->
                thinkingTones?.cancel()
                if (phase == WakePhase.THINKING) thinkingTones = launch { tickWhileThinking() }
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
        listeningCue?.close()
        listeningCue = null
        wakeLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
        coordinator?.let(LinkRuntime::release)
        coordinator = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf(lastStartId)
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
        const val ACTION_CANCEL_QUESTION = "io.agentmux.audioinbox.WAKE_CANCEL_QUESTION"
        const val ACTION_RELISTEN = "io.agentmux.audioinbox.WAKE_RELISTEN"
        const val ACTION_TRY_OPEN = "io.agentmux.audioinbox.WAKE_TRY_OPEN"
        const val ACTION_TRY_CLOSE = "io.agentmux.audioinbox.WAKE_TRY_CLOSE"
        const val EXTRA_QA_WAV = "qa_wake_wav"
    }
}
