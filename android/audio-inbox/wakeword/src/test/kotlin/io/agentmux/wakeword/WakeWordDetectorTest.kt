package io.agentmux.wakeword

import org.junit.Assert.assertTrue
import org.junit.Test

class WakeWordDetectorTest {
    private val threshold = WakePhrases.HEY_JARVIS.threshold

    private fun bestScore(fixture: String): Float = heyJarvisModels().use { models ->
        wavChunks(fixture).maxOf(WakeWordDetector(models)::score).also { println("$fixture max score $it") }
    }

    @Test
    fun aSwedishVoiceOverBrownNoiseWakesLink() {
        assertTrue(bestScore("hey-jarvis-question-sv-noise.wav") >= threshold)
    }

    @Test
    fun theWeakestMeasuredSwedishVoiceStillClearsTheThreshold() {
        assertTrue(bestScore("hey-jarvis-question-sv-soft.wav") >= threshold)
    }

    @Test
    fun aSwedishSentenceWithoutThePhraseStaysQuiet() {
        assertTrue(bestScore("swedish-no-wake-word.wav") < 0.1f)
    }

    @Test
    fun resetForgetsThePhraseSoItCannotRetrigger() {
        heyJarvisModels().use { models ->
            val detector = WakeWordDetector(models)
            wavChunks("hey-jarvis-question-sv-noise.wav").forEach { detector.score(it) }
            detector.reset()
            val afterReset = List(20) { detector.score(ShortArray(WAKE_CHUNK_SAMPLES)) }.max()
            assertTrue("score after reset $afterReset", afterReset < 0.1f)
        }
    }
}
