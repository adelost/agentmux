package io.agentmux.linkcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LinkReducerTest {
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

    private fun turn(id: String, target: String) = LinkTurn(
        turnId = id,
        targetId = target,
        targetLabel = target,
        userText = id,
        createdAtMs = 1,
    )
}
