package io.agentmux.wakeword

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Each step held to what it does to the loop, on the same WAV fixtures the detector is held to. A step that
 * only moved a number would pass a test of its number; what a wearer picks it for is whether a real clip is
 * heard or refused, so that is what is pinned here.
 */
class WakeSensitivityTest {
    /** One WAV through the real loop under one step, exactly as the two reports run it. */
    private fun heard(fixture: String, step: WakeSensitivity, phrase: WakePhrase = WakePhrases.HEY_JARVIS): Replayed =
        wakeModels(phrase).use { models ->
            SileroSpeechProbability.load(modelBytes("silero_vad.onnx")).use { vad ->
                val bytes = requireNotNull(javaClass.getResourceAsStream("/$fixture")).readBytes()
                replay(
                    phrase = phrase.copy(threshold = step.thresholdFor(phrase)),
                    models = models,
                    vad = vad,
                    samples = readPcm16Wav(bytes),
                    detection = step.detection,
                ).also { println("${step.id} $fixture wakes ${it.wakes.size} longest run ${it.longestRun} peak ${it.highestScore}") }
            }
        }

    @Test
    fun everyStepStillHearsASwedishVoiceOverNoise() {
        // A step a wearer picks to stop false wakes must not cost him the phrase itself.
        WakeSensitivity.offered.forEach { step ->
            assertEquals(step.id, 1, heard("hey-jarvis-question-sv-noise.wav", step).wakes.size)
        }
    }

    @Test
    fun theSoftSwedishVoiceIsRefusedByEveryStepForBeingOverTheThresholdOnceOnly() {
        // Measured 2026-09-19. This clip peaks at 0.42, over Hey Jarvis's 0.40, and the detector test pins
        // that peak; the loop still refuses it under every step, because the peak is one chunk long and no
        // step lets one chunk decide. It is the run rule's price, on a real recording, and EAGER does not
        // buy it back: at 0.30 the chunks either side are still too low to make a run.
        WakeSensitivity.offered.forEach { step ->
            assertEquals(step.id, 0, heard("hey-jarvis-question-sv-soft.wav", step).wakes.size)
        }
        val normal = heard("hey-jarvis-question-sv-soft.wav", WakeSensitivity.NORMAL)
        assertTrue("peak ${normal.highestScore}", normal.highestScore >= WakePhrases.HEY_JARVIS.threshold)
        assertEquals(1, normal.longestRun)
        assertEquals(1, normal.refusedRuns)
    }

    @Test
    fun noStepWakesOnASwedishSentenceWithoutThePhrase() {
        WakeSensitivity.offered.forEach { step ->
            assertEquals(step.id, 0, heard("swedish-no-wake-word.wav", step).wakes.size)
        }
    }

    @Test
    fun strictAsksForOneMoreChunkThanTheOtherTwo() {
        // Measured 2026-09-19: on the corpus every false wake STRICT removes is removed by this rule and not
        // by its margin, so the rule is the part that has to stay true.
        assertEquals(3, WakeSensitivity.STRICT.detection.chunksOverThreshold)
        assertEquals(WakeDetectionPolicy().chunksOverThreshold, WakeSensitivity.NORMAL.detection.chunksOverThreshold)
        assertEquals(WakeDetectionPolicy().chunksOverThreshold, WakeSensitivity.EAGER.detection.chunksOverThreshold)
    }

    @Test
    fun noStepLetsOneChunkDecide() {
        // A single chunk over the threshold is the shape of every false wake measured in an hour of radio.
        WakeSensitivity.entries.forEach { step ->
            val heard = OneQuestion()
            oneChunkOver(step, heard).run()
            assertEquals(step.id, 0, heard.detections)
        }
    }

    @Test
    fun eagerHearsAScoreNormalRefusesAndStrictRefusesTheOneNormalHears() {
        // 0.38 is the peak of the sv-SE-SofieNeural clip the README records as a known miss against 0.40;
        // EAGER exists so that voice has something to try. 0.42 clears NORMAL and STRICT's margin refuses it.
        assertTrue(scored(0.38f, WakeSensitivity.EAGER))
        assertTrue(!scored(0.38f, WakeSensitivity.NORMAL))
        assertTrue(scored(0.42f, WakeSensitivity.NORMAL))
        assertTrue(!scored(0.42f, WakeSensitivity.STRICT))
    }

    @Test
    fun aStepMovesEachPhraseFromItsOwnMeasuredThreshold() {
        // The phrase's own number stays the anchor: a step is an offset, never a replacement.
        val jarvis = WakePhrases.HEY_JARVIS
        val marvin = WakePhrases.HEY_MARVIN
        assertEquals(jarvis.threshold, WakeSensitivity.NORMAL.thresholdFor(jarvis), 0f)
        assertEquals(marvin.threshold, WakeSensitivity.NORMAL.thresholdFor(marvin), 0f)
        assertTrue(WakeSensitivity.STRICT.thresholdFor(jarvis) > jarvis.threshold)
        assertTrue(WakeSensitivity.EAGER.thresholdFor(jarvis) < jarvis.threshold)
        assertEquals(
            WakeSensitivity.STRICT.thresholdFor(marvin) - marvin.threshold,
            WakeSensitivity.STRICT.thresholdFor(jarvis) - jarvis.threshold,
            1e-6f,
        )
    }

    @Test
    fun aStoredStepComesBackAndAnUnknownOneDoesNot() {
        WakeSensitivity.offered.forEach { step -> assertEquals(step, WakeSensitivity.byId(step.id)) }
        assertNull(WakeSensitivity.byId("loudest"))
        assertNull(WakeSensitivity.byId(null))
    }

    /** Four chunks at one score, which is more than any step's rule asks for. */
    private fun scored(score: Float, step: WakeSensitivity): Boolean {
        val heard = OneQuestion()
        loop(List(4) { score } + List(40) { 0f }, step, heard).run()
        return heard.detections > 0
    }

    private fun oneChunkOver(step: WakeSensitivity, heard: OneQuestion) =
        loop(listOf(0.99f) + List(40) { 0f }, step, heard)

    private fun loop(scores: List<Float>, step: WakeSensitivity, heard: OneQuestion): WakeListeningLoop {
        var index = -1
        return WakeListeningLoop(
            source = object : WakePcmSource {
                override fun read(chunk: ShortArray): Boolean {
                    index += 1
                    return index < scores.size
                }
                override fun close() = Unit
            },
            detector = object : WakeChunkScorer {
                override fun score(chunk: ShortArray) = scores[index]
                override fun reset() = Unit
            },
            vad = object : SpeechChunkProbability {
                override fun probability(chunk: ShortArray) = 0.9f
                override fun reset() = Unit
            },
            threshold = step.thresholdFor(WakePhrases.HEY_JARVIS),
            endpoint = EndpointPolicy(),
            detection = step.detection,
            detectionAllowed = { true },
            listener = heard,
        )
    }

    private class OneQuestion : WakeLoopListener {
        var detections = 0
        override fun onDetected(score: Float) { detections += 1 }
        override fun onHearing(hearing: WakeHearing) = Unit
        override fun onQuestion(end: UtteranceEnd, pcm: ShortArray, startedAtMs: Long) = Unit
        override fun onSourceStopped() = Unit
    }
}
