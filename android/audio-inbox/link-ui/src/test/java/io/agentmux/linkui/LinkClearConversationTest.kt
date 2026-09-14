package io.agentmux.linkui

import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.ReplyPhase
import io.agentmux.linkui.product.LinkHistoryClearEvent
import io.agentmux.linkui.product.toHistoryPresentation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Mattias 2026-09-14: "någon knapp där för att ja, kasta föregående liksom."
class LinkClearConversationTest {
    private fun turn(id: String, target: String, reply: ReplyPhase = ReplyPhase.READY) =
        LinkTurn(id, target, target, id, createdAtMs = 1, deliveryPhase = DeliveryPhase.QUEUED, replyPhase = reply)

    @Test fun theSelectedConversationIsClearedWithAHeldPressNamingItsRecipient() {
        val state = LinkState(
            targets = listOf(LinkTarget("lsrc:3", "lsrc:3"), LinkTarget("claw:1", "claw:1")),
            selectedTargetId = "lsrc:3",
            turns = listOf(turn("a", "lsrc:3"), turn("b", "lsrc:3"), turn("c", "claw:1"), turn("d", "lsrc:3", ReplyPhase.THINKING)),
        )
        val cleared = mutableListOf<LinkHistoryClearEvent>()

        val row = requireNotNull(linkClearConversationRow(state.toHistoryPresentation(), icon = null) { cleared += it })

        assertEquals("CLEAR lsrc:3", row.title)
        assertEquals("2 on this phone", row.sub)
        assertTrue(row.holdToConfirm)
        row.onTap!!.invoke()
        assertEquals(listOf(LinkHistoryClearEvent("lsrc:3")), cleared)
    }

    @Test fun nothingToClearShowsNoControl() {
        val waiting = LinkState(selectedTargetId = "lsrc:3", turns = listOf(turn("d", "lsrc:3", ReplyPhase.THINKING)))
        assertNull(linkClearConversationRow(waiting.toHistoryPresentation(), icon = null) {})
        assertNull(linkClearConversationRow(LinkState().toHistoryPresentation(), icon = null) {})
    }
}
