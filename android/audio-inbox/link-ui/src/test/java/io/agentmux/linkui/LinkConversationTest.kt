package io.agentmux.linkui

import io.agentmux.linkcore.*
import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneId
import java.util.Locale

class LinkConversationTest {
    @Test fun retainedHistoryIsRecipientScopedAndSelectionSurvivesNewReplies() {
        val turns = (0..54).map { turn("$it", if (it % 2 == 0) "a" else "b") }
        val retained = LinkHistoryPolicy.retain(turns)
        assertEquals(50, retained.size)
        val selected = linkConversationTurns(retained, "a")
        assertTrue(selected.all { it.targetId == "a" })
        assertTrue(linkConversationTurns(retained, null).isEmpty())
        assertTrue(linkConversationTurns(retained, "absent").isEmpty())
        var opened: String? = null
        val rows = linkHistoryRows(selected, { opened = it }, ZoneId.of("UTC"), Locale.UK)
        assertEquals(selected.map { it.turnId }.reversed(), rows.map { it.key })
        val old = rows.last()
        old.onTap!!()
        assertEquals(selected.first().turnId, opened)
        val newer = linkConversationTurns(retained + turn("new", "a"), "a")
        assertEquals(selected.first(), newer.single { it.turnId == opened })
        assertEquals("old user text", selected.first().userText)
        // Exercise the production reducer at capacity, including a late reply
        // to the evicted turn. It must not resurrect or retarget that exchange.
        val ledger = LinkStateLedger(LinkState(turns = retained)) { }
        repeat(50) { ledger.dispatch(LinkAction.Submit(turn("next-$it", "a"))) }
        assertEquals(50, ledger.value.turns.size)
        assertNull(linkConversationTurns(ledger.value.turns, "a").firstOrNull { it.turnId == opened })
        val beforeLateReply = ledger.value
        ledger.dispatch(LinkAction.Reply(requireNotNull(opened), "a", "Too late"))
        assertEquals(beforeLateReply, ledger.value)
    }

    @Test fun emptyAndLongRowsArePreviewsNotDestructiveTextTransforms() {
        assertNull(linkHistoryRows(emptyList(), {}).single().onTap)
        val long = turn("long", "a").copy(userText = "word ".repeat(300), replyText = "Reply\n".repeat(800))
        val row = linkHistoryRows(listOf(long), {}).single()
        assertTrue(row.title.endsWith("…"))
        assertEquals(4800, long.replyText.length)
        assertTrue(row.multiline)
        val noReply = long.copy(replyText = "")
        assertNotNull(linkHistoryRows(listOf(noReply), {}).single().onTap)
        assertNull(linkReadAloudRow(noReply) { _, _ -> })
    }

    @Test fun everyWearAudioStateAddressesExactlyTheChosenTurnWithoutFakePause() {
        PlaybackPhase.entries.forEach { phase ->
            val sent = mutableListOf<Pair<PlaybackOperation, String>>()
            val row = linkReadAloudRow(turn("older", "a").copy(playbackPhase = phase)) { operation, id ->
                sent += operation to id
            }!!
            row.onTap!!()
            val expected = if (phase in setOf(PlaybackPhase.PLAYING, PlaybackPhase.QUEUED))
                PlaybackOperation.STOP else PlaybackOperation.PLAY
            assertEquals(listOf(expected to "older"), sent)
            assertFalse(row.holdToConfirm)
            assertEquals(com.adelost.designkit.ui.CircleActionTiming.IMMEDIATE, row.actionTiming)
        }
    }

    private fun turn(id: String, recipient: String) = LinkTurn(
        turnId = id, targetId = recipient, targetLabel = "Same label for both recipients",
        userText = "old user text", replyText = "Full reply", createdAtMs = 1_788_610_000_000L,
        replyPhase = ReplyPhase.READY,
    )
}
