package io.agentmux.linkui

import androidx.compose.runtime.Composable
import com.adelost.ringkit.ui.RingActionCueHost

/**
 * Link's controls declare their own kind, so this host no longer decides for them.
 *
 * It used to provide IMMEDIATE for every ordinary tap in the app. That was one sentence overriding
 * every control at once, and it is what let a row draw a half-second wait while its gate committed
 * on a press of one millisecond: the override reached the gate and never reached the drawing
 * (row 225, Mattias 2026-09-20). Each control now names its kind in
 * [io.agentmux.linkui.product.generated.GeneratedLinkControlTiming], declared in
 * product-spec/src/interactions.ts, and the kit resolves that one declaration for the gate, the cue
 * and the drawing alike.
 */
@Composable
fun LinkInteractionHost(content: @Composable () -> Unit) {
    RingActionCueHost(content = content)
}
