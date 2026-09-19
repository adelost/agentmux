package io.agentmux.audioinbox

import io.agentmux.wakeword.RecordedTry
import io.agentmux.wakeword.WakePhrases
import io.agentmux.wakeword.WakeSensitivity
import io.agentmux.wakeword.WakeStepAnswer
import io.agentmux.wakeword.WakeTry
import io.agentmux.wakeword.WakeTryVerdict
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.ZoneId

/**
 * Row 217: the page answers a question a wearer asked out loud, so what it answers is worth reading back.
 * Nothing here needs a screen: the words are what is tested, and the judging is `:wakeword`'s own.
 */
class LinkWakeTryWordsTest {

    private val phrase = WakePhrases.HEY_JARVIS
    private val zone = ZoneId.of("Europe/Stockholm")

    @Test fun aPageNobodyHasSpokenToSaysWhatToDoAndThatNothingIsSent() {
        assertEquals("SAY IT NOW", wakeTryVerdictWords(WakeTryVerdict.SAY_IT_NOW))
        assertEquals("Listening · nothing is sent", wakeTryWhy(null, WakeSensitivity.NORMAL, phrase))
        assertEquals("··", wakeTryStepWord(null, WakeSensitivity.STRICT))
    }

    @Test fun aWakeSaysHowMuchOfItWasHeard() {
        val heard = tryWith(peak = 0.62f, longestRun = 4, wakes = WakeSensitivity.offered.toSet())

        assertEquals("Heard for 4 chunks in a row", wakeTryWhy(heard, WakeSensitivity.NORMAL, phrase))
        assertEquals("WAKES", wakeTryStepWord(heard, WakeSensitivity.STRICT))
    }

    @Test fun aRefusalNamesTheStepThatRefusedItAndTheNearestOneThatWouldNotHave() {
        // The measured shape of the soft Swedish clip: over NORMAL's mark, never over STRICT's.
        val refused = tryWith(peak = 0.43f, longestRun = 2, wakes = setOf(WakeSensitivity.NORMAL, WakeSensitivity.EAGER))

        assertEquals("NOT HEARD", wakeTryVerdictWords(refused.judged.verdictFor(WakeSensitivity.STRICT, phrase)))
        assertEquals(
            "STRICT needs 0.45 three times · try NORMAL",
            wakeTryWhy(refused, WakeSensitivity.STRICT, phrase),
        )
        assertEquals("NO", wakeTryStepWord(refused, WakeSensitivity.STRICT))
    }

    @Test fun aTryNoStepWouldHaveHeardSaysHowCloseItCame() {
        val refused = tryWith(peak = 0.41f, longestRun = 1, wakes = emptySet())

        assertEquals("NORMAL needs 0.40 twice · this one reached it once", wakeTryWhy(refused, WakeSensitivity.NORMAL, phrase))
    }

    @Test fun somethingElseSaidIsNotTheSameAsThePhraseNotBeingHeard() {
        // Under EAGER's mark with speech in it: he said something, and it was not the phrase.
        val spoken = tryWith(peak = 0.21f, longestRun = 0, wakes = emptySet())

        assertEquals(
            WakeTryVerdict.HEARD_SPEECH_NOT_THE_PHRASE,
            spoken.judged.verdictFor(WakeSensitivity.NORMAL, phrase),
        )
        assertEquals(
            "Heard you, but nothing in it sounded like the phrase",
            wakeTryWhy(spoken, WakeSensitivity.NORMAL, phrase),
        )
    }

    @Test fun aPastTryIsOneLineOfClockPeakAndWhatItWouldHaveDone() {
        val at = 1_758_310_000_000L // 2025-09-19 21:26:40 in Stockholm
        val all = RecordedTry(tryWith(0.62f, 4, WakeSensitivity.offered.toSet()).judged, 800L, at)
        val two = RecordedTry(tryWith(0.43f, 2, setOf(WakeSensitivity.NORMAL, WakeSensitivity.EAGER)).judged, 800L, at)
        val one = RecordedTry(tryWith(0.31f, 2, setOf(WakeSensitivity.EAGER)).judged, 800L, at)
        val none = RecordedTry(tryWith(0.19f, 0, emptySet()).judged, 800L, at)

        assertEquals("21:26:40  0.62  wakes on all three", wakeTryLine(all, zone))
        assertEquals("21:26:40  0.43  only EAGER and NORMAL", wakeTryLine(two, zone))
        assertEquals("21:26:40  0.31  only EAGER", wakeTryLine(one, zone))
        assertEquals("21:26:40  0.19  no step wakes", wakeTryLine(none, zone))
    }

    private fun tryWith(peak: Float, longestRun: Int, wakes: Set<WakeSensitivity>): RecordedTry = RecordedTry(
        judged = WakeTry(
            highestScore = peak,
            heardSpeech = true,
            byStep = WakeSensitivity.offered.associateWith { step ->
                WakeStepAnswer(wakes = step in wakes, longestRun = longestRun)
            },
        ),
        atMs = 800L,
        wallClockMs = 0L,
    )
}
