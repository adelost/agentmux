package io.agentmux.linkui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import com.adelost.designkit.ui.CircleActionTiming
import com.adelost.designkit.ui.LocalCircleTapTiming
import com.adelost.ringkit.ui.RingActionCueHost

/** Immediate conversation actions stay in place. CircleKit suppresses their
 * confirmation flash while retaining explicitly requested information. */
@Composable
fun LinkInteractionHost(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalCircleTapTiming provides CircleActionTiming.IMMEDIATE) {
        RingActionCueHost(content = content)
    }
}
