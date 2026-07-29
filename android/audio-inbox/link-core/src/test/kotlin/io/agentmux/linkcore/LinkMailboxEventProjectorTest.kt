package io.agentmux.linkcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LinkMailboxEventProjectorTest {
    @Test
    fun `watch event projects once and can be replayed without duplicates`() {
        val event = LinkMailboxEvent(
            seq = 1,
            clientMessageId = "turn-one",
            targetId = "agent:1",
            state = "replied",
            body = "",
            replyBody = "Svar",
            createdAtMs = 42,
            replyAtMs = 45,
        )
        val first = reduce(LinkState(targets = listOf(LinkTarget("agent:1", "AGENT"))), event)
        val second = reduce(first, event)

        assertEquals(1, second.turns.size)
        assertEquals("Voice message", second.turns.single().userText)
        assertEquals("Svar", second.turns.single().replyText)
        assertEquals(ReplyPhase.READY, second.turns.single().replyPhase)
    }

    @Test
    fun `unknown state never fabricates acceptance`() {
        val event = LinkMailboxEvent(
            2,
            "turn-two",
            "agent:1",
            "mystery",
            "Hej",
            "",
            43,
            0,
        )
        val actions = LinkMailboxEventProjector.actions(LinkState(), event)

        assertEquals(1, actions.size)
        assertTrue(actions.single() is LinkAction.Submit)
    }

    private fun reduce(initial: LinkState, event: LinkMailboxEvent): LinkState =
        LinkMailboxEventProjector.actions(initial, event)
            .fold(initial, LinkReducer::reduce)
}
