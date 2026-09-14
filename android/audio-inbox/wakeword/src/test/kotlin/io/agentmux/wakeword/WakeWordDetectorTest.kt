package io.agentmux.wakeword

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WakeWordDetectorTest {
    private fun bestScore(fixture: String, phrase: WakePhrase = WakePhrases.HEY_JARVIS): Float = wakeModels(phrase).use { models ->
        wavChunks(fixture).maxOf(WakeWordDetector(models)::score).also { println("${phrase.id} $fixture max score $it") }
    }

    @Test
    fun aSwedishVoiceOverBrownNoiseWakesLink() {
        assertTrue(bestScore("hey-jarvis-question-sv-noise.wav") >= WakePhrases.HEY_JARVIS.threshold)
    }

    @Test
    fun theWeakestMeasuredSwedishVoiceStillClearsTheThreshold() {
        assertTrue(bestScore("hey-jarvis-question-sv-soft.wav") >= WakePhrases.HEY_JARVIS.threshold)
    }

    // Mattias 2026-09-14: "hade man haft kanske ändå haft tre att välja mellan". Python openWakeWord 0.4.0 scores these clips 0.9999 and 0.9986.
    @Test
    fun everyOfferedPhraseWakesOnASwedishVoiceOverNoiseAndMatchesThePythonReference() {
        assertEquals(0.9999f, bestScore("hey-marvin-question-sv-noise.wav", WakePhrases.HEY_MARVIN), 0.002f)
        assertEquals(0.9986f, bestScore("alexa-question-sv-noise.wav", WakePhrases.ALEXA), 0.002f)
        assertEquals(listOf("hey-jarvis", "hey-marvin", "alexa"), WakePhrases.offered.map { it.id })
    }

    @Test
    fun aSwedishSentenceWithoutThePhraseStaysQuiet() {
        WakePhrases.offered.forEach { phrase -> assertTrue(phrase.id, bestScore("swedish-no-wake-word.wav", phrase) < 0.1f) }
    }

    @Test
    fun resetForgetsThePhraseSoItCannotRetrigger() {
        wakeModels(WakePhrases.HEY_JARVIS).use { models ->
            val detector = WakeWordDetector(models)
            wavChunks("hey-jarvis-question-sv-noise.wav").forEach { detector.score(it) }
            detector.reset()
            val afterReset = List(20) { detector.score(ShortArray(WAKE_CHUNK_SAMPLES)) }.max()
            assertTrue("score after reset $afterReset", afterReset < 0.1f)
        }
    }
}
