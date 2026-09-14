package io.agentmux.wakeword

import org.junit.Assert.assertTrue
import org.junit.Test

class WakeWordDetectorTest {
    @Test
    fun spokenComputerScoresAboveTheDefaultThreshold() {
        computerModels().use { models ->
            val best = wavChunks("computer-question-en.wav").maxOf(WakeWordDetector(models)::score)
            println("computer-question-en max score $best")
            assertTrue("max score $best", best >= 0.9f)
        }
    }

    @Test
    fun swedishSentenceWithoutTheWordStaysQuiet() {
        computerModels().use { models ->
            val best = wavChunks("swedish-no-wake-word.wav").maxOf(WakeWordDetector(models)::score)
            println("swedish-no-wake-word max score $best")
            assertTrue("max score $best", best < 0.1f)
        }
    }

    @Test
    fun resetForgetsTheWakeWordSoItCannotRetrigger() {
        computerModels().use { models ->
            val detector = WakeWordDetector(models)
            wavChunks("computer-question-en.wav").forEach { detector.score(it) }
            detector.reset()
            val afterReset = List(20) { detector.score(ShortArray(WAKE_CHUNK_SAMPLES)) }.max()
            assertTrue("score after reset $afterReset", afterReset < 0.1f)
        }
    }
}
