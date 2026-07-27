package io.agentmux.linkcore

import org.junit.Assert.assertEquals
import org.junit.Test

class RecoveredReplyPolicyTest {
    @Test
    fun `reconnect preserves timeline but autoplays only newest eligible direct reply`() {
        val timeline = listOf(
            RecoveredReply("old", 1, 100, true),
            RecoveredReply("middle", 2, 1_000, true),
            RecoveredReply("new", 3, 1_000, true),
        )

        assertEquals(listOf("old", "middle", "new"), timeline.map { it.turnId })
        assertEquals("new", RecoveredReplyPolicy.autoplayTurnId(timeline, nowMs = 500))
    }
}
