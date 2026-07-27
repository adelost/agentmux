package io.agentmux.linkcore

import org.junit.Assert.assertEquals
import org.junit.Test

class PhoneWearReducerParityTest {
    @Test
    fun `phone and round watch consume one state contract`() {
        val actions = listOf<LinkAction>(
            LinkAction.Connection(ConnectionState.CONNECTED, "Connected"),
            LinkAction.Targets(listOf(LinkTarget("lsrc:3", "lsrc:3"))),
            LinkAction.Capture(CapturePhase.LISTENING, 10),
            LinkAction.Capture(CapturePhase.FINALIZING),
            LinkAction.Submit(
                LinkTurn("turn-1", "lsrc:3", "lsrc:3", "Hej", createdAtMs = 20),
            ),
            LinkAction.Accepted("turn-1", "Hej"),
            LinkAction.Reply("turn-1", "lsrc:3", "Svar"),
            LinkAction.Playback("turn-1", PlaybackPhase.PLAYING),
            LinkAction.Playback("turn-1", PlaybackPhase.STOPPED),
        )

        val phone = actions.fold(LinkState(), LinkReducer::reduce)
        val wear = actions.fold(LinkState(), LinkReducer::reduce)

        assertEquals(phone, wear)
        assertEquals(PlaybackPhase.STOPPED, phone.turns.single().playbackPhase)
        assertEquals(ReplyPhase.READY, phone.turns.single().replyPhase)
        assertEquals("lsrc:3", phone.turns.single().respondingTarget)
    }
}
