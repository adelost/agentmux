package io.agentmux.audioinbox

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import io.agentmux.wakeword.WakeEvent
import io.agentmux.wakeword.WakePhase
import io.agentmux.wakeword.WakePhrase
import io.agentmux.wakeword.WakePhrases
import io.agentmux.wakeword.WakeSensitivity
import io.agentmux.wakeword.WakeStatus
import io.agentmux.wakeword.WakeTrace
import io.agentmux.wakeword.WakeTraceBuffer
import io.agentmux.wakeword.reduce
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

internal const val KEY_WAKE_WORD = "wakeWord"
private const val KEY_WAKE_PHRASE = "wakePhrase"
private const val KEY_WAKE_DEBUG = "wakeDebug"
private const val KEY_WAKE_SENSITIVITY = "wakeSensitivity"

/** The one process-wide hands-free status, written by the service and read by settings and the notification. */
internal object LinkWakeStatus {
    private val mutable = MutableStateFlow(WakeStatus())
    val status: StateFlow<WakeStatus> = mutable.asStateFlow()

    /** Main thread only: the service, its microphone callbacks and the settings toggle all post here. */
    fun apply(event: WakeEvent): WakeStatus {
        check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) { "Wake status changes on the main thread" }
        mutable.value = mutable.value.reduce(event)
        return mutable.value
    }
}

/**
 * WHAT: Whether the microphone loop is being watched, and the bounded trace it writes when it is.
 * WHY: Watching costs one extra speech-model call per 80 ms chunk, so it is off until someone asks and it
 * is remembered, and the trace itself never leaves memory unless the wearer exports it. The switch is stored
 * natively beside the wake phrase rather than declared: it changes nothing a product surface promises, it
 * only decides whether the loop reports what it hears.
 */
internal object LinkWakeDebug {
    /** One buffer for the process, like the status: the microphone thread writes it, the page reads it. */
    val trace = WakeTraceBuffer()

    private val mutableWatching = MutableStateFlow(false)
    val watching: StateFlow<Boolean> = mutableWatching.asStateFlow()

    fun restore(context: Context) {
        mutableWatching.value = preferences(context).getBoolean(KEY_WAKE_DEBUG, false)
    }

    fun setWatching(context: Context, on: Boolean) {
        preferences(context).edit().putBoolean(KEY_WAKE_DEBUG, on).apply()
        mutableWatching.value = on
        if (!on) trace.clear()
        // The loop reads this once, when it opens: a change takes effect on the next listening pass.
        context.startService(Intent(context, WakeWordService::class.java).setAction(WakeWordService.ACTION_RELISTEN))
    }

    fun read(): WakeTrace = trace.read()

    /**
     * Writes what is in memory to one file and answers with its name. This is the only thing that ever
     * writes a trace to storage: watching alone leaves nothing behind.
     */
    fun export(context: Context): String {
        val snapshot = trace.read()
        val file = java.io.File(
            context.getExternalFilesDir(null) ?: context.filesDir,
            "wake-trace-${System.currentTimeMillis()}.tsv",
        )
        file.bufferedWriter().use { out ->
            // The clock column is the wearer's, the millisecond column is the loop's: one says when it
            // happened to him, the other how far into this listening pass it was.
            out.write("clock\tatMs\tpeakScore\tchunksOverThreshold\tspeech\tverdict\n")
            snapshot.runs.asReversed().forEach { traced ->
                val run = traced.run
                out.write(
                    "%s\t%d\t%.4f\t%d\t%.4f\t%s\n".format(
                        runClock(traced.wallClockMs), run.atMs, run.peakScore, run.chunksOverThreshold,
                        run.speechProbability, run.refusal?.name ?: "HEARD",
                    ),
                )
            }
        }
        return file.name
    }

    private fun preferences(context: Context) =
        context.getSharedPreferences(AppContract.PREFS, Context.MODE_PRIVATE)
}

/** The chosen wake phrase: stored beside the other Link preferences and applied to a running loop at once. */
internal object LinkWakePhraseChoice {
    fun choose(context: Context, phrase: WakePhrase) {
        context.getSharedPreferences(AppContract.PREFS, Context.MODE_PRIVATE).edit().putString(KEY_WAKE_PHRASE, phrase.id).apply()
        LinkWakeStatus.apply(WakeEvent.PhraseChosen(phrase))
    }

    /** Never chosen, or an id a later build no longer offers: the default phrase. */
    fun restore(context: Context) {
        val stored = context.getSharedPreferences(AppContract.PREFS, Context.MODE_PRIVATE).getString(KEY_WAKE_PHRASE, null)
        LinkWakeStatus.apply(WakeEvent.PhraseChosen(WakePhrases.byId(stored) ?: WakePhrases.offered.first()))
    }
}

/**
 * WHAT: How eagerly the wake word answers, stored beside the chosen phrase.
 * WHY: The phrase and the sensitivity are the same kind of choice, one the wearer makes about a loop that
 * keeps running, so they are kept and applied the same way: written here, reduced into the status, and
 * taken up by the microphone loop when it reopens.
 */
internal object LinkWakeSensitivityChoice {
    fun choose(context: Context, sensitivity: WakeSensitivity) {
        context.getSharedPreferences(AppContract.PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_WAKE_SENSITIVITY, sensitivity.id).apply()
        LinkWakeStatus.apply(WakeEvent.SensitivityChosen(sensitivity))
        // What is in the trace was heard under the rule that has just been replaced, and WAKE DEBUG names
        // the step beside every run, so keeping those rows would put this step's name on another step's
        // verdicts. They go with the rule that produced them.
        LinkWakeDebug.trace.clear()
        // The step decides the loop's rule and its threshold, both of which are read when the loop opens.
        context.startService(Intent(context, WakeWordService::class.java).setAction(WakeWordService.ACTION_RELISTEN))
    }

    /** Never chosen, or a name a later build no longer offers: what Link measures best at. */
    fun restore(context: Context) {
        val stored = context.getSharedPreferences(AppContract.PREFS, Context.MODE_PRIVATE)
            .getString(KEY_WAKE_SENSITIVITY, null)
        LinkWakeStatus.apply(WakeEvent.SensitivityChosen(WakeSensitivity.byId(stored) ?: WakeSensitivity.NORMAL))
    }
}

/**
 * WHAT: The one sentence a wearer reads when the wake word is on and the microphone is not his to use.
 * WHY: lsrc:0 M4, 2026-09-19. Losing the permission never wrote the preference off, so the loop simply
 * never started and every surface read OFF: a wake word that is on and cannot hear looked exactly like one
 * that is off. It is worded once, here, and the row only prints the phase word and this reason.
 */
internal const val MICROPHONE_NEEDED = "microphone needed · tap to allow"

/** What a resume does with the wake word. Named so the rule can be read and tested without a phone. */
internal enum class WakeResumeAction { NOTHING, BLOCK_ON_PERMISSION, START }

/**
 * On and allowed, so listen; on and not allowed, so say so; off, so nothing. A loop that is already
 * running is left alone, and one that was blocked is started again once the permission comes back.
 */
internal fun wakeResumeAction(enabled: Boolean, microphoneGranted: Boolean, phase: WakePhase): WakeResumeAction = when {
    !enabled -> WakeResumeAction.NOTHING
    !microphoneGranted -> WakeResumeAction.BLOCK_ON_PERMISSION
    phase == WakePhase.OFF || phase == WakePhase.BLOCKED -> WakeResumeAction.START
    else -> WakeResumeAction.NOTHING
}

/**
 * WHAT: The phone's WAKE WORD preference: permission, battery exemption and the listening service.
 * WHY: A microphone service may only start while Link is on screen; this runs from the settings toggle and on resume.
 */
internal class LinkWakeWordControl(
    private val context: Context,
    private val requestMicrophone: () -> Unit,
) {
    private val preferences = context.getSharedPreferences(AppContract.PREFS, Context.MODE_PRIVATE)
    private val mutableEnabled = MutableStateFlow(preferences.getBoolean(KEY_WAKE_WORD, false))
    val enabled: StateFlow<Boolean> = mutableEnabled.asStateFlow()

    init {
        LinkWakePhraseChoice.restore(context)
        LinkWakeSensitivityChoice.restore(context)
        LinkWakeDebug.restore(context)
    }

    fun setEnabled(on: Boolean) {
        if (on && !microphoneGranted()) {
            requestMicrophone()
            LinkWakeStatus.apply(WakeEvent.Blocked(MICROPHONE_NEEDED))
            return
        }
        preferences.edit().putBoolean(KEY_WAKE_WORD, on).apply()
        mutableEnabled.value = on
        if (on) {
            requestUnrestrictedBattery()
            start()
        } else {
            context.startService(Intent(context, WakeWordService::class.java).setAction(WakeWordService.ACTION_STOP))
        }
    }

    /** Drops the hands-free question still being heard; the service ignores it once the question is sending. */
    fun cancelQuestion() {
        context.startService(Intent(context, WakeWordService::class.java).setAction(WakeWordService.ACTION_CANCEL_QUESTION))
    }

    /** Restores listening after the process was gone; the Activity is visible, so the start is allowed. */
    fun resume() {
        mutableEnabled.value = preferences.getBoolean(KEY_WAKE_WORD, false)
        when (wakeResumeAction(mutableEnabled.value, microphoneGranted(), LinkWakeStatus.status.value.phase)) {
            WakeResumeAction.NOTHING -> Unit
            WakeResumeAction.BLOCK_ON_PERMISSION -> LinkWakeStatus.apply(WakeEvent.Blocked(MICROPHONE_NEEDED))
            WakeResumeAction.START -> start()
        }
    }

    private fun start() {
        context.startForegroundService(Intent(context, WakeWordService::class.java).setAction(WakeWordService.ACTION_START))
    }

    private fun microphoneGranted(): Boolean =
        context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /** Reading a reply aloud from the background needs Link exempt from battery optimization. */
    @SuppressLint("BatteryLife")
    private fun requestUnrestrictedBattery() {
        val power = context.getSystemService(PowerManager::class.java)
        if (power.isIgnoringBatteryOptimizations(context.packageName)) return
        context.startActivity(
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}")),
        )
    }
}

internal fun wakeBatteryRestricted(context: Context): Boolean =
    !context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)
