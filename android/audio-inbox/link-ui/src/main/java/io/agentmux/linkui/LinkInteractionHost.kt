package io.agentmux.linkui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import com.adelost.designkit.ui.CircleActionTiming
import com.adelost.designkit.ui.LocalCircleTapTiming

/** Conversation actions give feedback in place. A centre-screen confirmation
 * scrim would hide the recorder and text precisely when the user needs them. */
@Composable
fun LinkInteractionHost(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalCircleTapTiming provides CircleActionTiming.IMMEDIATE) {
        content()
    }
}
