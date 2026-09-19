package io.agentmux.audioinbox

import io.agentmux.wakeword.TracedRun
import io.agentmux.wakeword.WakeRefusal
import io.agentmux.wakeword.WakeRun
import io.agentmux.wakeword.WakeSensitivity
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.ZoneId

/**
 * lsrc:0 D2, 2026-09-19: a run's row leads with its verdict, and its time is a clock rather than a count
 * of seconds that does not say since what.
 */
class WakeRunRowTest {
    private val zone = ZoneId.of("Europe/Stockholm")

    // 2026-09-19 18:56:09 in Stockholm.
    private val at = java.time.ZonedDateTime.of(2026, 9, 19, 18, 56, 9, 0, zone).toInstant().toEpochMilli()

    private fun traced(peak: Float, chunks: Int, refusal: WakeRefusal?, speech: Float = 1f) =
        TracedRun(WakeRun(9_040, peak, chunks, speech, refusal), at)

    @Test
    fun theVerdictLeadsAndTheScoreFollowsIt() {
        assertEquals("REFUSED · 0.45", runTitle(traced(0.4453f, 1, WakeRefusal.NOT_ENOUGH_CHUNKS).run))
        assertEquals("WOKE · 0.71", runTitle(traced(0.7071f, 2, null).run))
    }

    @Test
    fun theSecondLineSaysWhyAndWhenOnTheWearersOwnClock() {
        assertEquals(
            "one chunk only, NORMAL wants 2 · speech 1.00 · 18:56:09",
            runSentence(traced(0.45f, 1, WakeRefusal.NOT_ENOUGH_CHUNKS), WakeSensitivity.NORMAL, zone),
        )
        assertEquals(
            "2 chunks, STRICT wants 3 · speech 0.67 · 18:56:09",
            runSentence(traced(0.55f, 2, WakeRefusal.NOT_ENOUGH_CHUNKS, speech = 0.67f), WakeSensitivity.STRICT, zone),
        )
        assertEquals(
            "became a question · speech 1.00 · 18:56:09",
            runSentence(traced(0.9f, 2, null), WakeSensitivity.NORMAL, zone),
        )
    }

    // The verdict is the title's, so the sentence must not say it twice.
    @Test
    fun theSentenceNeverRepeatsTheVerdict() {
        listOf(
            traced(0.45f, 1, WakeRefusal.NOT_ENOUGH_CHUNKS),
            traced(0.9f, 2, null),
        ).forEach { run ->
            val sentence = runSentence(run, WakeSensitivity.NORMAL, zone)
            assertEquals(sentence, false, sentence.contains("REFUSED") || sentence.contains("WOKE"))
        }
    }

    @Test
    fun aClockIsReadInTheWearersOwnZone() {
        assertEquals("18:56:09", runClock(at, zone))
        assertEquals("16:56:09", runClock(at, ZoneId.of("UTC")))
    }
}
