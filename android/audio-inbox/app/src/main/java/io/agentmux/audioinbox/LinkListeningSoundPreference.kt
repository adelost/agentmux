package io.agentmux.audioinbox

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

internal const val KEY_LISTENING_CUE_SOUND = "listeningCueSound"

/** WHAT: Owns the phone's listening-sound choice. WHY: Sound may be disabled without changing haptic feedback or microphone behavior. */
internal class LinkListeningSoundPreference(context: Context) {
    private val preferences = context.getSharedPreferences(AppContract.PREFS, Context.MODE_PRIVATE)
    private val mutableEnabled = MutableStateFlow(isEnabled(context))
    val enabled: StateFlow<Boolean> = mutableEnabled.asStateFlow()

    fun setEnabled(enabled: Boolean) {
        preferences.edit().putBoolean(KEY_LISTENING_CUE_SOUND, enabled).apply()
        mutableEnabled.value = enabled
    }

    companion object {
        fun isEnabled(context: Context): Boolean = context
            .getSharedPreferences(AppContract.PREFS, Context.MODE_PRIVATE)
            .getBoolean(KEY_LISTENING_CUE_SOUND, true)
    }
}
