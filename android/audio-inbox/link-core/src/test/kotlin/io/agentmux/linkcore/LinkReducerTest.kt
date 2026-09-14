package io.agentmux.linkcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LinkReducerTest {
    @Test fun `a chosen recipient survives a momentarily empty catalog during discovery`() {
        val chosen = LinkState(
            targets = listOf(LinkTarget("lsrc:3", "THREE"), LinkTarget("claw:1", "ONE")),
            selectedTargetId = "claw:1",
        )
        val empty = LinkReducer.reduce(chosen, LinkAction.Targets(emptyList()))
        val restored = LinkReducer.reduce(empty, LinkAction.Targets(chosen.targets))
        assertEquals("claw:1", restored.selectedTargetId)
    }

    @Test fun `megabyte text and aggregate history are bounded before persistence and presentation`() {
        val huge = "x".repeat(1_048_576)
        var saved = LinkState()
        val ledger = LinkStateLedger(LinkState()) { saved = it }
        repeat(55) { index ->
            val id = "large-$index"
            ledger.dispatch(LinkAction.Submit(turn(id, "agent").copy(userText = huge)))
            ledger.dispatch(LinkAction.Reply(id, "agent", huge))
        }
        assertEquals(saved, ledger.value)
        assertTrue(saved.turns.size < LinkHistoryPolicy.MAX_LOCAL_TURNS)
        assertTrue(saved.turns.sumOf(LinkHistoryPolicy::textSize) <= LinkHistoryPolicy.MAX_HISTORY_CHARS)
        assertEquals("large-54", saved.turns.last().turnId)
        saved.turns.forEach {
            assertTrue(it.userText.length <= LinkHistoryPolicy.MAX_MESSAGE_CHARS)
            assertTrue(it.replyText.length <= LinkHistoryPolicy.MAX_MESSAGE_CHARS)
            assertTrue(it.replyText.endsWith(LinkHistoryPolicy.SHORTENED))
        }
        val cut = LinkHistoryPolicy.MAX_MESSAGE_CHARS - LinkHistoryPolicy.SHORTENED.length
        val unicode = "x".repeat(cut - 1) + "😀" + huge
        val bounded = LinkHistoryPolicy.boundedText(unicode)
        assertEquals("x".repeat(cut - 1) + LinkHistoryPolicy.SHORTENED, bounded)
        assertEquals(bounded, LinkHistoryPolicy.boundedText(bounded))
    }

    @Test fun `one playback owner survives switching and late stop of the old reply`() {
        var state = LinkState(turns = listOf(turn("a", "agent:1"), turn("b", "agent:2")))
        state = LinkReducer.reduce(state, LinkAction.Playback("a", PlaybackPhase.QUEUED))
        assertEquals("a", state.activePlaybackTurnId)
        state = LinkReducer.reduce(state, LinkAction.Playback("a", PlaybackPhase.PLAYING))
        state = LinkReducer.reduce(state, LinkAction.Playback("b", PlaybackPhase.PLAYING))
        assertEquals(1, state.turns.count { it.playbackPhase == PlaybackPhase.PLAYING })
        assertEquals(PlaybackPhase.STOPPED, state.turns[0].playbackPhase)
        state = LinkReducer.reduce(state, LinkAction.Playback("a", PlaybackPhase.STOPPED))
        assertEquals("b", state.activePlaybackTurnId)
        state = LinkReducer.reduce(state, LinkAction.Playback("b", PlaybackPhase.PAUSED))
        assertEquals("b", state.activePlaybackTurnId)
        state = LinkReducer.reduce(state, LinkAction.PlaybackFailed("b", "Offline"))
        assertNull(state.activePlaybackTurnId)
    }
    @Test
    fun `session reset clears private conversation state`() {
        val initial = LinkState(
            targets = listOf(LinkTarget("agent:1", "ONE")),
            selectedTargetId = "agent:1",
            turns = listOf(turn("private-turn", "agent:1")),
            handsFree = true,
        )

        val reset = LinkReducer.reduce(initial, LinkAction.ResetSession)

        assertTrue(reset.targets.isEmpty())
        assertTrue(reset.turns.isEmpty())
        assertEquals("", reset.selectedTargetId)
        assertEquals(false, reset.handsFree)
    }

    @Test
    fun `turn B can start while turn A is thinking and replies keep their origin`() {
        val targets = listOf(
            LinkTarget("lsrc:3", "lsrc:3"),
            LinkTarget("lsrc:10", "lsrc:10"),
        )
        var state = LinkReducer.reduce(LinkState(), LinkAction.Targets(targets))
        state = LinkReducer.reduce(state, LinkAction.Submit(turn("a", "lsrc:3")))
        state = LinkReducer.reduce(state, LinkAction.Accepted("a", "first"))
        state = LinkReducer.reduce(state, LinkAction.Submit(turn("b", "lsrc:10")))
        state = LinkReducer.reduce(state, LinkAction.Accepted("b", "second"))
        state = LinkReducer.reduce(state, LinkAction.Reply("b", "lsrc:10", "B reply"))
        state = LinkReducer.reduce(state, LinkAction.Reply("a", "lsrc:3", "A reply"))

        assertEquals(ReplyPhase.READY, state.turns[0].replyPhase)
        assertEquals("lsrc:3", state.turns[0].respondingTarget)
        assertEquals("lsrc:10", state.turns[1].respondingTarget)
    }

    @Test
    fun `stop is terminal for automatic playback until explicit playback action`() {
        var state = LinkReducer.reduce(LinkState(), LinkAction.Submit(turn("a", "lsrc:3")))
        state = LinkReducer.reduce(state, LinkAction.Accepted("a", "first"))
        state = LinkReducer.reduce(state, LinkAction.Reply("a", "lsrc:3", "reply"))
        state = LinkReducer.reduce(state, LinkAction.Playback("a", PlaybackPhase.PLAYING))
        state = LinkReducer.reduce(state, LinkAction.Playback("a", PlaybackPhase.STOPPED))

        assertEquals(PlaybackPhase.STOPPED, state.turns.single().playbackPhase)
        assertEquals(ReplyPhase.READY, state.turns.single().replyPhase)
        assertNull(state.activePlaybackTurnId)

        state = LinkReducer.reduce(state, LinkAction.Playback("a", PlaybackPhase.PLAYING))
        assertEquals(PlaybackPhase.PLAYING, state.turns.single().playbackPhase)
    }

    @Test
    fun `independent turn axes retain A thinking while B is ready and stopped`() {
        var state = LinkReducer.reduce(LinkState(), LinkAction.Submit(turn("a", "lsrc:3")))
        state = LinkReducer.reduce(state, LinkAction.Accepted("a", "A"))
        state = LinkReducer.reduce(state, LinkAction.Submit(turn("b", "lsrc:10")))
        state = LinkReducer.reduce(state, LinkAction.Accepted("b", "B"))
        state = LinkReducer.reduce(state, LinkAction.Reply("b", "lsrc:10", "reply B"))
        state = LinkReducer.reduce(state, LinkAction.Playback("b", PlaybackPhase.PLAYING))
        state = LinkReducer.reduce(state, LinkAction.Playback("b", PlaybackPhase.STOPPED))

        assertEquals(ReplyPhase.THINKING, state.turns[0].replyPhase)
        assertEquals(PlaybackPhase.IDLE, state.turns[0].playbackPhase)
        assertEquals(ReplyPhase.READY, state.turns[1].replyPhase)
        assertEquals(PlaybackPhase.STOPPED, state.turns[1].playbackPhase)
        assertEquals("reply B", state.turns[1].replyText)
    }

    @Test
    fun `playback progress belongs to its turn and never changes playback phase`() {
        var state = LinkReducer.reduce(LinkState(), LinkAction.Submit(turn("a", "lsrc:3")))
        state = LinkReducer.reduce(state, LinkAction.Playback("a", PlaybackPhase.PAUSED))
        state = LinkReducer.reduce(state, LinkAction.PlaybackProgress("a", 12_500L, 60_000L))

        assertEquals(PlaybackPhase.PAUSED, state.turns.single().playbackPhase)
        assertEquals(12_500L, state.turns.single().playbackPositionMs)
        assertEquals(60_000L, state.turns.single().playbackDurationMs)
    }

    @Test
    fun `local history retains exactly the newest fifty turns`() {
        var state = LinkState()
        repeat(55) { index ->
            state = LinkReducer.reduce(
                state,
                LinkAction.Submit(turn("turn-$index", "lsrc:3")),
            )
        }

        assertEquals(LinkHistoryPolicy.MAX_LOCAL_TURNS, state.turns.size)
        assertEquals("turn-5", state.turns.first().turnId)
        assertEquals("turn-54", state.turns.last().turnId)
    }

    // Mattias 2026-09-14: "någon knapp där för att ja, kasta föregående ... de som är då cachade på mobilen."
    @Test fun `clearing a conversation drops its settled turns on this phone and keeps anything still on its way`() {
        val answered = turn("answered", "lsrc:3").copy(deliveryPhase = DeliveryPhase.QUEUED, replyPhase = ReplyPhase.READY)
        val notSent = turn("not-sent", "lsrc:3").copy(deliveryPhase = DeliveryPhase.FAILED)
        val sending = turn("sending", "lsrc:3").copy(deliveryPhase = DeliveryPhase.SENDING)
        val thinking = turn("thinking", "lsrc:3").copy(deliveryPhase = DeliveryPhase.QUEUED, replyPhase = ReplyPhase.THINKING)
        val playing = answered.copy(turnId = "playing", playbackPhase = PlaybackPhase.PLAYING)
        val otherRecipient = answered.copy(turnId = "other", targetId = "claw:1")
        val state = LinkState(turns = listOf(answered, notSent, sending, thinking, playing, otherRecipient), activePlaybackTurnId = "playing")

        val cleared = LinkReducer.reduce(state, LinkAction.ClearConversation("lsrc:3"))

        assertEquals(listOf("sending", "thinking", "playing", "other"), cleared.turns.map { it.turnId })
        assertEquals("playing", cleared.activePlaybackTurnId)
        assertEquals(2, state.clearableTurns("lsrc:3"))
    }

    private fun turn(id: String, target: String) = LinkTurn(
        turnId = id,
        targetId = target,
        targetLabel = target,
        userText = id,
        createdAtMs = 1,
    )
}
