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
import io.agentmux.wakeword.WakeStatus
import io.agentmux.wakeword.reduce
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

internal const val KEY_WAKE_WORD = "wakeWord"
private const val KEY_WAKE_PHRASE = "wakePhrase"

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
    }

    fun setEnabled(on: Boolean) {
        if (on && !microphoneGranted()) {
            requestMicrophone()
            LinkWakeStatus.apply(WakeEvent.Blocked("Allow the microphone, then turn WAKE WORD on again"))
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
        if (mutableEnabled.value && microphoneGranted() && LinkWakeStatus.status.value.phase == WakePhase.OFF) start()
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
