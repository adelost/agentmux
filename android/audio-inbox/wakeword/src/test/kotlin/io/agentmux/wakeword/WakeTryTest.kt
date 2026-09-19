package io.agentmux.wakeword

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Row 217: one utterance judged under every step at once is the TRY page's whole promise, so the judge is
 * held to the LOOP's answer rather than to its own arithmetic. The three committed fixtures are run both
 * ways: through [judgeUnderEveryStep] once, and through the real [WakeListeningLoop] once per step.
 */
class WakeTryTest {

    private val phrase = WakePhrases.HEY_JARVIS

    @Test
    fun theJudgeAnswersWhatTheLoopItselfWouldDo() {
        listOf(
            "hey-jarvis-question-sv-noise.wav",
            "hey-jarvis-question-sv-soft.wav",
            "swedish-no-wake-word.wav",
        ).forEach { fixture ->
            val judged = judge(fixture)
            WakeSensitivity.offered.forEach { step ->
                val theLoop = loopWakes(fixture, step)
                assertEquals(
                    "$fixture under ${step.id}",
                    theLoop,
                    judged.byStep.getValue(step).wakes,
                )
            }
        }
    }

    @Test
    fun theSoftSwedishVoiceIsHeardAsSpeechAndRefusedByEveryStep() {
        // The clip peaks over Hey Jarvis's threshold for ONE chunk, which no step lets decide. It is the
        // page's most useful answer: the phrase was said, and the wearer is told the run rule refused it
        // rather than being told nothing was heard.
        val judged = judge("hey-jarvis-question-sv-soft.wav")

        assertTrue("peak ${judged.highestScore}", judged.highestScore >= phrase.threshold)
        assertTrue("the voice model heard the speech", judged.heardSpeech)
        WakeSensitivity.offered.forEach { step ->
            assertFalse(step.id, judged.byStep.getValue(step).wakes)
            // Over EAGER's mark, so it is not "heard speech, not the phrase": the phrase WAS in it.
            assertEquals(step.id, WakeTryVerdict.NOT_HEARD, judged.verdictFor(step, phrase))
        }
        // How close it came differs by step, and that is what the page's rows are for: the peak of 0.42
        // clears NORMAL's 0.40 and EAGER's 0.30 for one chunk, and never reaches STRICT's 0.45 at all.
        assertEquals(1, judged.byStep.getValue(WakeSensitivity.NORMAL).longestRun)
        assertEquals(1, judged.byStep.getValue(WakeSensitivity.EAGER).longestRun)
        assertEquals(0, judged.byStep.getValue(WakeSensitivity.STRICT).longestRun)
    }

    @Test
    fun aSentenceWithoutThePhraseIsHeardSpeechRatherThanSilence() {
        val judged = judge("swedish-no-wake-word.wav")

        assertTrue("the voice model heard the speech", judged.heardSpeech)
        assertTrue("peak ${judged.highestScore}", judged.highestScore < WakeSensitivity.EAGER.thresholdFor(phrase))
        WakeSensitivity.offered.forEach { step ->
            assertEquals(step.id, WakeTryVerdict.HEARD_SPEECH_NOT_THE_PHRASE, judged.verdictFor(step, phrase))
        }
    }

    @Test
    fun silenceIsNotHeardAtAll() {
        val judged = judgeUnderEveryStep(FloatArray(20), FloatArray(20), phrase)

        assertFalse(judged.heardSpeech)
        WakeSensitivity.offered.forEach { step ->
            assertEquals(step.id, WakeTryVerdict.NOT_HEARD, judged.verdictFor(step, phrase))
            assertEquals(step.id, 0, judged.byStep.getValue(step).longestRun)
        }
    }

    /**
     * The fixtures above pin each step's THRESHOLD, not its run length: measured, none of the three has a
     * run that is long enough for two and short enough for three, so a judge that used one policy for every
     * step still agrees with the loop on all nine. This case is what pins the length, and it goes red on
     * exactly that mutation. Both are needed; neither covers the other.
     */
    @Test
    fun aRunOfTwoWakesNormalAndEagerAndLeavesStrictOneChunkShort() {
        val over = phrase.threshold + 0.2f
        val judged = judgeUnderEveryStep(floatArrayOf(0f, over, over, 0f), FloatArray(4) { 0.9f }, phrase)

        assertTrue(judged.byStep.getValue(WakeSensitivity.NORMAL).wakes)
        assertTrue(judged.byStep.getValue(WakeSensitivity.EAGER).wakes)
        assertFalse(judged.byStep.getValue(WakeSensitivity.STRICT).wakes)
        assertEquals(2, judged.byStep.getValue(WakeSensitivity.STRICT).longestRun)
    }

    /**
     * Measured on a phone 2026-09-19, and the reason the page holds the loop rather than cancelling what
     * it starts: a clip that wakes every step read NO under STRICT on the glass. Dropping the question
     * after it began reset the detector in the middle of the phrase, and the rest of the run never
     * reached the page. Held the other way, what the page is handed is what the file says.
     */
    @Test
    fun aLoopThatMayNotAskAQuestionHandsThePageTheWholeUtterance() {
        val fixture = "hey-jarvis-question-sv-noise.wav"
        val whileWatching = pageWatching(fixture)
        val fromTheFile = judge(fixture)

        WakeSensitivity.offered.forEach { step ->
            assertEquals(
                "$fixture under ${step.id}",
                fromTheFile.byStep.getValue(step).wakes,
                whileWatching.byStep.getValue(step).wakes,
            )
        }
        // Named, because this is the one the truncated run lost: the strictest step needs a third chunk
        // and only gets it if nothing interrupted the phrase.
        assertTrue(whileWatching.byStep.getValue(WakeSensitivity.STRICT).wakes)
    }

    /** The clip through the real loop with the page's own recorder on it, as a phone runs TRY mode. */
    private fun pageWatching(fixture: String): WakeTry = wakeModels(phrase).use { models ->
        SileroSpeechProbability.load(modelBytes("silero_vad.onnx")).use { vad ->
            val recorder = WakeTryRecorder(phrase)
            val bytes = requireNotNull(javaClass.getResourceAsStream("/$fixture")).readBytes()
            replay(
                phrase = phrase,
                models = models,
                vad = vad,
                samples = readPcm16Wav(bytes),
                detection = WakeSensitivity.NORMAL.detection,
                watcher = recorder,
                questionsAllowed = false,
            )
            recorder.read().tries.first().judged
        }
    }

    /** Every chunk of the fixture scored once by each model, in order, exactly as the loop meets them. */
    private fun judge(fixture: String): WakeTry = wakeModels(phrase).use { models ->
        SileroSpeechProbability.load(modelBytes("silero_vad.onnx")).use { vad ->
            val detector = WakeWordDetector(models)
            val chunks = wavChunks(fixture)
            val scores = FloatArray(chunks.size) { detector.score(chunks[it]) }
            vad.reset()
            val speech = FloatArray(chunks.size) { vad.probability(chunks[it]) }
            judgeUnderEveryStep(scores, speech, phrase)
        }
    }

    /** The same clip through the real loop under one step: the answer the judge has to agree with. */
    private fun loopWakes(fixture: String, step: WakeSensitivity): Boolean = wakeModels(phrase).use { models ->
        SileroSpeechProbability.load(modelBytes("silero_vad.onnx")).use { vad ->
            val bytes = requireNotNull(javaClass.getResourceAsStream("/$fixture")).readBytes()
            replay(
                phrase = phrase.copy(threshold = step.thresholdFor(phrase)),
                models = models,
                vad = vad,
                samples = readPcm16Wav(bytes),
                detection = step.detection,
            ).wakes.isNotEmpty()
        }
    }
}
