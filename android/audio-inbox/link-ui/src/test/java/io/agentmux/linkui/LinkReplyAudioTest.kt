package io.agentmux.linkui

import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.ReplyPhase
import org.junit.Assert.assertEquals
import org.junit.Test

class LinkReplyAudioTest {
    private val turn = LinkTurn("t", "claw:1", "claw:1", "Vad är klockan?", replyText = "Klockan är sex.",
        createdAtMs = 1, replyPhase = ReplyPhase.READY, playbackPhase = PlaybackPhase.PLAYED)

    @Test
    fun savedAudioIsPlayableAndShowsItsLength() {
        assertEquals(LinkReadAloudRow("READ ALOUD", "0:12", tappable = true, muted = false),
            linkReadAloudRow(turn, LinkReplyAudio.Saved(12_300)))
    }

    @Test
    fun prunedAudioIsGreyAndNeverReportedAsAFailure() {
        assertEquals(LinkReadAloudRow("AUDIO EXPIRED", "Tap to regenerate", tappable = true, muted = true),
            linkReadAloudRow(turn, LinkReplyAudio.Expired(regenerable = true)))
        assertEquals(LinkReadAloudRow("AUDIO EXPIRED", "", tappable = false, muted = true),
            linkReadAloudRow(turn, LinkReplyAudio.Expired(regenerable = false)))
    }

    @Test
    fun onlyARealPlaybackFailureAsksForARetry() {
        val failed = turn.copy(playbackPhase = PlaybackPhase.FAILED, playbackError = "tts HTTP 502")
        assertEquals(LinkReadAloudRow("READ ALOUD", "Tap to retry", tappable = true, muted = false),
            linkReadAloudRow(failed, LinkReplyAudio.Expired(regenerable = true)))
    }
}
