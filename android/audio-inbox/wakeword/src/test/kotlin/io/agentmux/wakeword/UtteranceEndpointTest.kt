package io.agentmux.wakeword

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UtteranceEndpointTest {
    private val policy = EndpointPolicy()

    private fun run(probabilities: List<Float>): Pair<UtteranceEnd, Int> {
        var progress = UtteranceProgress()
        probabilities.forEach { probability ->
            progress = progress.advance(probability, policy)
            val end = progress.end(policy)
            if (end != UtteranceEnd.NONE) return end to progress.elapsedMs
        }
        return UtteranceEnd.NONE to progress.elapsedMs
    }

    @Test
    fun silenceAfterTheWakeWordGivesUpWithoutAQuestion() {
        assertEquals(UtteranceEnd.NO_SPEECH to 5_040, run(List(100) { 0f }))
    }

    @Test
    fun aPauseAfterSpeechFinishesTheQuestion() {
        val spoken = List(10) { 0f } + List(25) { 0.9f } + List(40) { 0f }
        assertEquals(UtteranceEnd.COMPLETE to (35 * 80 + 1_200), run(spoken))
    }

    @Test
    fun aShortBreathInsideTheQuestionDoesNotEndIt() {
        val spoken = List(20) { 0.9f } + List(10) { 0f } + List(20) { 0.9f }
        assertEquals(UtteranceEnd.NONE, run(spoken).first)
    }

    @Test
    fun endlessSpeechStopsAtTheHardCap() {
        assertEquals(UtteranceEnd.MAX_LENGTH to 30_000, run(List(400) { 0.9f }))
    }

    @Test
    fun sileroFindsTheEndOfARealSwedishSentence() {
        SileroSpeechProbability.load(modelBytes("silero_vad.onnx")).use { vad ->
            val probabilities = wavChunks("swedish-no-wake-word.wav").map(vad::probability)
            val (end, atMs) = run(probabilities + List(40) { vad.probability(ShortArray(WAKE_CHUNK_SAMPLES)) })
            println("swedish sentence ended $end at $atMs ms, speech chunks ${probabilities.count { it >= 0.5f }}")
            assertEquals(UtteranceEnd.COMPLETE, end)
            assertTrue("ended at $atMs ms", atMs in 2_500..6_000)
        }
    }
}
