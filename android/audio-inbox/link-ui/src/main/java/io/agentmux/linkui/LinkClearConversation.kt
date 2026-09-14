package io.agentmux.linkui

import androidx.compose.ui.graphics.vector.ImageVector
import com.adelost.ringkit.ui.RowSpec
import io.agentmux.linkui.product.LinkHistoryClearEvent
import io.agentmux.linkui.product.LinkHistoryPresentation

/**
 * WHAT: The one control that forgets the selected conversation on this phone.
 * WHY: Mattias 2026-09-14 wants to throw away earlier turns. It is a held press
 *      like every destructive CircleKit row, and absent when nothing can go.
 *      Turns still sending, thinking or being read aloud stay (see LinkAction.ClearConversation).
 */
fun linkClearConversationRow(
    history: LinkHistoryPresentation,
    icon: ImageVector?,
    onClear: (LinkHistoryClearEvent) -> Unit,
): RowSpec? {
    val targetId = history.targetId ?: return null
    if (history.clearableTurns == 0) return null
    return RowSpec(
        key = "history.clear",
        title = "CLEAR $targetId",
        sub = "${history.clearableTurns} on this phone",
        icon = icon,
        hint = "Hold to remove this conversation from this phone. Agents and Discord keep theirs.",
        holdToConfirm = true,
        onTap = { onClear(LinkHistoryClearEvent(targetId)) },
    )
}
