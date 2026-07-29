package io.agentmux.linkcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LinkMailboxSyncTest {
    @Test
    fun `phone and wear consume identical transitions heartbeats and cursor`() {
        val initial = LinkState(
            targets = listOf(
                LinkTarget("agent:1", "ONE", available = false),
                LinkTarget("agent:2", "TWO", available = true),
            ),
        )
        val events = listOf(
            event(7, "queued"),
            event(8, "replied", reply = "Klart"),
        )

        val first = LinkMailboxSync.apply(
            initial,
            afterSeq = 6,
            events = events,
            heartbeatStates = mapOf("agent:1" to true),
        )
        val phone = first.actions.fold(initial, LinkReducer::reduce)
        val wear = first.actions.fold(initial, LinkReducer::reduce)

        assertEquals(phone, wear)
        assertEquals(8L, first.afterSeq)
        assertEquals(listOf("turn-one"), first.repliedTurnIds)
        assertTrue(phone.targets.first { it.id == "agent:1" }.available)
        assertFalse(phone.targets.first { it.id == "agent:2" }.available)
        assertEquals("Klart", phone.turns.single().replyText)
    }

    @Test
    fun `already consumed events never rewind or duplicate state`() {
        val initial = LinkState(targets = listOf(LinkTarget("agent:1", "ONE")))
        val result = LinkMailboxSync.apply(
            initial,
            afterSeq = 8,
            events = listOf(event(7, "queued"), event(8, "replied", reply = "old")),
            heartbeatStates = mapOf("agent:1" to true),
        )

        assertEquals(8L, result.afterSeq)
        assertTrue(result.repliedTurnIds.isEmpty())
        assertTrue(result.actions.none { it is LinkAction.Submit })
    }

    private fun event(
        seq: Long,
        state: String,
        reply: String = "",
    ) = LinkMailboxEvent(
        seq = seq,
        clientMessageId = "turn-one",
        targetId = "agent:1",
        state = state,
        body = "Hej",
        replyBody = reply,
        lastError = "",
        createdAtMs = 42,
        replyAtMs = 45,
    )
}
