package io.agentmux.linkui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import com.adelost.designkit.ui.CircleActionTiming
import com.adelost.designkit.ui.LocalCircleTapTiming
import com.adelost.ringkit.ui.RingActionCueHost

/** Conversation controls are reversible clicks. PTT/confirm lifecycles are
 * separate atoms and deliberately retain their explicit hold contract. */
@Composable
fun LinkInteractionHost(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalCircleTapTiming provides CircleActionTiming.IMMEDIATE) {
        RingActionCueHost(content = content)
    }
}
