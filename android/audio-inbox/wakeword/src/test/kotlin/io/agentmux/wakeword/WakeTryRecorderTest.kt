package io.agentmux.wakeword

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Row 217: the TRY page's answer only means anything if one thing said is one try. The recorder is what
 * decides that, from the same chunk stream and the same endpoint rule a question is captured with.
 */
class WakeTryRecorderTest {

    private val phrase = WakePhrases.HEY_JARVIS
    private val over = phrase.threshold + 0.2f

    @Test
    fun onePhraseSaidIsOneTryJudgedWhenTheSpeakerHasStopped() {
        val recorder = WakeTryRecorder(phrase, wallClock = { 1_000L })

        recorder.quiet(chunks = 4)
        recorder.said(scores = listOf(0.1f, over, over, 0.2f))
        assertTrue("still speaking, so nothing is judged yet", recorder.read().tries.isEmpty())
        assertTrue(recorder.read().speaking)

        recorder.quiet(chunks = trailingChunks())
        val tries = recorder.read().tries
        assertEquals(1, tries.size)
        assertFalse("the try ended with the speaker", recorder.read().speaking)
        assertEquals(over, tries.single().judged.highestScore, 0.0001f)
        assertEquals(1_000L, tries.single().wallClockMs)
        // Two chunks in a row is what NORMAL and EAGER ask for and one short of what STRICT does.
        assertTrue(tries.single().judged.byStep.getValue(WakeSensitivity.NORMAL).wakes)
        assertFalse(tries.single().judged.byStep.getValue(WakeSensitivity.STRICT).wakes)
    }

    @Test
    fun aQuietRoomIsNeverATry() {
        val recorder = WakeTryRecorder(phrase)

        recorder.quiet(chunks = (WAKE_TRY_ENDPOINT.waitForSpeechMs / WAKE_CHUNK_MS) + 10)

        assertTrue(recorder.read().tries.isEmpty())
        assertFalse(recorder.read().speaking)
        assertNull("a verdict nobody earned", recorder.read().showing())
    }

    @Test
    fun onlyTheLastFiveTriesAreKeptAndTheNewestIsFirst() {
        val recorder = WakeTryRecorder(phrase, keep = 5)

        // Each try peaks a little higher than the one before it, so which five were kept is readable.
        repeat(7) { index ->
            recorder.said(scores = listOf(over + 0.01f * index, over))
            recorder.quiet(chunks = trailingChunks())
        }

        val tries = recorder.read().tries
        assertEquals(5, tries.size)
        assertEquals("the seventh is first", over + 0.06f, tries.first().judged.highestScore, 0.0001f)
        assertEquals("and the third is last; the first two are gone", over + 0.02f, tries.last().judged.highestScore, 0.0001f)
        assertTrue("newest first", tries.first().atMs > tries.last().atMs)
    }

    @Test
    fun aVerdictHoldsUntilHeSpeaksAgainOrSixSecondsOfListening() {
        val recorder = WakeTryRecorder(phrase)
        recorder.said(scores = listOf(over, over))
        recorder.quiet(chunks = trailingChunks())
        val judged = requireNotNull(recorder.read().showing())

        recorder.quiet(chunks = 2)
        assertSame("still the same answer a moment later", judged.judged, recorder.read().showing()?.judged)

        recorder.quiet(chunks = WAKE_TRY_VERDICT_HOLD_MS.toInt() / WAKE_CHUNK_MS)
        assertNull("nothing said for six seconds, so the page is at rest again", recorder.read().showing())
    }

    @Test
    fun theNextThingSaidClearsTheAnswerToTheLastOne() {
        val recorder = WakeTryRecorder(phrase)
        recorder.said(scores = listOf(over, over))
        recorder.quiet(chunks = trailingChunks())
        assertTrue(recorder.read().showing() != null)

        recorder.said(scores = listOf(0.1f))

        assertNull("he is saying the next one", recorder.read().showing())
        assertEquals("and the answer to the last one is still in the list", 1, recorder.read().tries.size)
    }

    /** How long the recorder waits after the last speech chunk before it judges what it heard. */
    private fun trailingChunks(): Int = WAKE_TRY_ENDPOINT.trailingSilenceMs / WAKE_CHUNK_MS

    private var atMs = 0L

    private fun WakeTryRecorder.said(scores: List<Float>) =
        scores.forEach { score -> chunk(score = score, speechProbability = 0.9f) }

    private fun WakeTryRecorder.quiet(chunks: Int) =
        repeat(chunks) { chunk(score = 0.02f, speechProbability = 0.02f) }

    private fun WakeTryRecorder.chunk(score: Float, speechProbability: Float) {
        atMs += WAKE_CHUNK_MS
        onChunkScored(atMs, score, speechProbability, 0)
    }
}
