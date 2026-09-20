package io.agentmux.linkui

import androidx.compose.ui.graphics.vector.ImageVector
import com.adelost.ringkit.ui.RowSpec
import io.agentmux.linkui.product.generated.GeneratedLinkControlTiming
import io.agentmux.linkui.product.generated.GeneratedLinkHistoryClear
import io.agentmux.linkui.product.generated.GeneratedLinkHistoryStatus

/**
 * WHAT: The one control that forgets the selected conversation on this phone.
 * WHY: Mattias 2026-09-14 wants to throw away earlier turns. It is a held press
 *      like every destructive CircleKit row, and absent when nothing can go.
 *      Turns still sending, thinking or being read aloud stay (see LinkAction.ClearConversation).
 */
fun linkClearConversationRow(
    history: GeneratedLinkHistoryStatus,
    icon: ImageVector?,
    onClear: (GeneratedLinkHistoryClear) -> Unit,
): RowSpec? {
    val targetId = history.targetId ?: return null
    if (history.clearableTurns == 0L) return null
    return RowSpec(
        key = "history.clear",
        title = "CLEAR $targetId",
        sub = "${history.clearableTurns} on this phone",
        icon = icon,
        hint = "Hold to remove this conversation from this phone. Agents and Discord keep theirs.",
        holdToConfirm = true,
        // The one Link control that waits, and it says so from the product's own declaration rather
        // than from this call site: clearing is not taken back by a second press (row 225).
        actionTiming = GeneratedLinkControlTiming.HISTORY_CLEAR,
        onTap = { onClear(GeneratedLinkHistoryClear(targetId)) },
    )
}
