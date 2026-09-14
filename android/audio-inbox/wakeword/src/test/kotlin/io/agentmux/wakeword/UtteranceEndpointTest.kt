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

    // Mattias 2026-09-14: 1.2 s was "alldeles för het på gröten"; he asked for two to three seconds.
    @Test
    fun aPauseOfTwoAndAHalfSecondsAfterSpeechFinishesTheQuestion() {
        val spoken = List(10) { 0f } + List(25) { 0.9f } + List(40) { 0f }
        assertEquals(UtteranceEnd.COMPLETE to (35 * 80 + 32 * 80), run(spoken))
        assertEquals(UtteranceEnd.NONE, run(List(25) { 0.9f } + List(25) { 0f }).first)
    }

    @Test
    fun aPauseCountsDownToSendingAndSpeakingAgainResetsIt() {
        fun after(probabilities: List<Float>) =
            probabilities.fold(UtteranceProgress()) { progress, probability -> progress.advance(probability, policy) }
        assertEquals(null, after(List(10) { 0f }).sendsInMs(policy))
        assertEquals(null, after(List(10) { 0.9f }).sendsInMs(policy))
        assertEquals(2_500 - 10 * 80, after(List(10) { 0.9f } + List(10) { 0f }).sendsInMs(policy))
        assertEquals(null, after(List(10) { 0.9f } + List(10) { 0f } + List(1) { 0.9f }).sendsInMs(policy))
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
