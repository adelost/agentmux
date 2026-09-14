package io.agentmux.audioinbox

import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.ReplyPhase
import io.agentmux.wakeword.TurnProgress
import io.agentmux.wakeword.TurnStage
import org.junit.Assert.assertEquals
import org.junit.Test

class LinkWakeTurnsTest {
    private fun turn(delivery: DeliveryPhase, reply: ReplyPhase = ReplyPhase.NONE, playback: PlaybackPhase = PlaybackPhase.IDLE) =
        LinkTurn("t", "claw", "claw", "Voice message…", replyText = "Klockan är tre.", createdAtMs = 1,
            deliveryPhase = delivery, replyPhase = reply, playbackPhase = playback, playbackError = "tts 500")

    @Test
    fun aReadyReplyKeepsThinkingUntilReadAloudStartsThenFinishesWhenPlayed() {
        val ready = turn(DeliveryPhase.QUEUED, ReplyPhase.READY)
        assertEquals(TurnStage.THINKING, ready.wakeProgress().stage)
        assertEquals(true, ready.awaitsReadAloud())
        assertEquals(TurnStage.SPEAKING, ready.copy(playbackPhase = PlaybackPhase.PLAYING).wakeProgress().stage)
        assertEquals(TurnStage.SPOKEN, ready.copy(playbackPhase = PlaybackPhase.PLAYED).wakeProgress().stage)
    }

    @Test
    fun aFailedReadAloudCarriesItsReason() {
        assertEquals(
            TurnProgress(TurnStage.SPEAK_FAILED, "tts 500"),
            turn(DeliveryPhase.QUEUED, ReplyPhase.READY, PlaybackPhase.FAILED).wakeProgress(),
        )
    }

    @Test
    fun aTurnEvictedFromHistoryReleasesTheLoop() {
        assertEquals(TurnStage.GONE, (null as LinkTurn?).wakeProgress().stage)
    }
}
