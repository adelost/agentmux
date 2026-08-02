package io.agentmux.audioinbox

import android.content.Context
import com.adelost.designkit.ui.CircleHostMode
import com.adelost.designkit.ui.CircleHostOrientation
import com.adelost.designkit.ui.CircleHostPreviewPreferences
import com.adelost.designkit.ui.CircleHostPreviewState
import com.adelost.ringkit.ui.CircleHostPreviewPort
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Owns only Phone DEV presentation; Link state, navigation and callbacks stay outside it. */
internal class LinkHostController(
    context: Context,
    private val onOrientationChanged: (CircleHostOrientation) -> Unit,
) {
    private val preferences = CircleHostPreviewPreferences(context, "agentmux-link")
    private val mutableState = MutableStateFlow(preferences.load())
    val state: StateFlow<CircleHostPreviewState> = mutableState.asStateFlow()

    val port = CircleHostPreviewPort(
        isWatchDevice = false,
        state = state,
        systemOrientationAllowed = true,
        onMode = { update(state.value.copy(mode = it)) },
        onDiameter = { update(state.value.copy(watchDiameterDp = it)) },
        onOrientation = { update(state.value.copy(orientation = it)) },
    )

    fun restoreOrientation() = onOrientationChanged(state.value.orientation)

    fun update(next: CircleHostPreviewState) {
        preferences.save(next)
        mutableState.value = next
        onOrientationChanged(next.orientation)
    }

    fun applyQa(mode: String?, diameter: String?, orientation: String?) {
        var next = state.value
        CircleHostMode.entries.singleOrNull { it.name == mode }?.let { next = next.copy(mode = it) }
        diameter?.toFloatOrNull()?.let { next = next.copy(watchDiameterDp = it) }
        CircleHostOrientation.entries.singleOrNull { it.name == orientation }
            ?.let { next = next.copy(orientation = it) }
        if (next != state.value) update(next)
    }
}
