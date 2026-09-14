package io.agentmux.linkui

import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.ReplyPhase
import org.junit.Assert.assertEquals
import org.junit.Test

// Mattias 2026-09-14: "Ska det verkligen stå read aloud? ... Bild före text tycker jag alltid."
class LinkReplyAudioTest {
    private val turn = LinkTurn("t", "claw:1", "claw:1", "Vad är klockan?", replyText = "Klockan är sex.",
        createdAtMs = 1, replyPhase = ReplyPhase.READY, playbackPhase = PlaybackPhase.PLAYED)

    @Test
    fun savedAudioIsASpeakerWithOnlyItsLength() {
        assertEquals(LinkReadAloudRow(ReadAloudIcon.SPEAKER, "0:12", tappable = true, muted = false),
            linkReadAloudRow(turn, LinkReplyAudio.Saved(12_300)))
        assertEquals(LinkReadAloudRow(ReadAloudIcon.SPEAKER, "", tappable = true, muted = false),
            linkReadAloudRow(turn, LinkReplyAudio.NotGenerated))
    }

    @Test
    fun prunedAudioIsAGreyRefreshAndNeverReportedAsAFailure() {
        assertEquals(LinkReadAloudRow(ReadAloudIcon.REFRESH, "", tappable = true, muted = true),
            linkReadAloudRow(turn, LinkReplyAudio.Expired(regenerable = true)))
        assertEquals(LinkReadAloudRow(ReadAloudIcon.SPEAKER, "", tappable = false, muted = true),
            linkReadAloudRow(turn, LinkReplyAudio.Expired(regenerable = false)))
    }

    @Test
    fun onlyARealPlaybackFailureOffersARetry() {
        val failed = turn.copy(playbackPhase = PlaybackPhase.FAILED, playbackError = "tts HTTP 502")
        assertEquals(LinkReadAloudRow(ReadAloudIcon.REFRESH, "", tappable = true, muted = false),
            linkReadAloudRow(failed, LinkReplyAudio.Expired(regenerable = true)))
    }

    @Test
    fun noReadAloudRowCarriesWords() {
        val rows = listOf(LinkReplyAudio.Saved(9_000), LinkReplyAudio.NotGenerated,
            LinkReplyAudio.Expired(true), LinkReplyAudio.Expired(false))
            .map { linkReadAloudRow(turn, it) } + linkReadAloudRow(turn.copy(playbackPhase = PlaybackPhase.FAILED), LinkReplyAudio.NotGenerated)
        rows.forEach { assertEquals("", it.length.filter(Char::isLetter)) }
    }
}
