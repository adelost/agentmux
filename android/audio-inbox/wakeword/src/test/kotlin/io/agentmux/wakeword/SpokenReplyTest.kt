package io.agentmux.wakeword

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SpokenReplyTest {
    private val more = "Hela svaret finns i Link."

    @Test
    fun aShortReplyIsReadWholeWithoutMarkup() {
        val spoken = spokenReply("**Klockan** är tre.\n- Se [schemat](https://example.com) och `cal`", more)
        assertEquals(SpokenReply("Klockan är tre. Se schemat och cal.", shortened = false), spoken)
    }

    @Test
    fun aLongReportSpeaksItsSummaryLineAndPointsToTheScreen() {
        val report = "SUMMARY: Bygget är grönt och släppt.\nDONE: tre filer.\n```kotlin\nval x = 1\n```\n" + "Detalj. ".repeat(120)
        assertEquals(SpokenReply("Bygget är grönt och släppt. $more", shortened = true), spokenReply(report, more))
    }

    @Test
    fun aLongReplyWithoutSummarySpeaksTheFirstParagraphCutAtASentence() {
        val reply = "Första meningen är kort. " + "Andra meningen fortsätter länge utan slut ".repeat(20) + ".\n\nSista stycket."
        val spoken = spokenReply(reply, more, fullReadChars = 100)
        assertTrue(spoken.text, spoken.text.startsWith("Första meningen är kort. Hela"))
    }
}
