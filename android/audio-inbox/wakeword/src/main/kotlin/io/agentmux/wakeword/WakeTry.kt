package io.agentmux.wakeword

/**
 * WHAT: One spoken try, judged under every sensitivity step at once.
 *
 * WHY IT CAN BE DONE AT ALL, which is the whole idea of the TRY page: a chunk's score does not depend on the
 * step. The model scores the chunk, and only then is the score compared with a threshold the step moved. So
 * one utterance can be judged three ways from one pass, and a wearer never has to say the phrase again to
 * find out what the other two steps would have done.
 *
 * Every answer here comes from [WakeRunCounter], the same rule [WakeListeningLoop] counts with. A page that
 * said "this would wake" by its own arithmetic would be a promise nothing keeps.
 */

/** What the try would do under one step. */
data class WakeStepAnswer(
    val wakes: Boolean,
    /** The most chunks in a row that were at or over this step's threshold: how close the try came. */
    val longestRun: Int,
)

/**
 * One try's answer. [highestScore] is the utterance's own peak and is the same under every step, because the
 * threshold is applied after the model has scored: it is what the meter holds and what the marks are read
 * against.
 */
data class WakeTry(
    val highestScore: Float,
    /** Whether the voice model heard speech at all, by the same floor the question endpoint uses. */
    val heardSpeech: Boolean,
    val byStep: Map<WakeSensitivity, WakeStepAnswer>,
) {
    /**
     * What the page says about this try, for the step the wearer is on.
     *
     * The words are product copy and are declared with the rest of them; this is only which of them is true.
     * A try that passed no step but reached EAGER's mark is NOT_HEARD rather than HEARD_SPEECH: the phrase
     * was in it and the run rule refused it, which is a different thing from saying something else.
     */
    fun verdictFor(step: WakeSensitivity, phrase: WakePhrase): WakeTryVerdict = when {
        byStep[step]?.wakes == true -> WakeTryVerdict.WOULD_WAKE
        heardSpeech && highestScore < WakeSensitivity.EAGER.thresholdFor(phrase) ->
            WakeTryVerdict.HEARD_SPEECH_NOT_THE_PHRASE
        else -> WakeTryVerdict.NOT_HEARD
    }
}

/** Which of the page's answers a try earns. SAY_IT_NOW is the page at rest, before anything is tried. */
enum class WakeTryVerdict { SAY_IT_NOW, WOULD_WAKE, HEARD_SPEECH_NOT_THE_PHRASE, NOT_HEARD }

/**
 * Judges [scores] under every offered step. [speech] carries the voice model's probability for the same
 * chunks, in the same order; a shorter list only means fewer chunks were asked about.
 */
fun judgeUnderEveryStep(
    scores: FloatArray,
    speech: FloatArray,
    phrase: WakePhrase,
    endpoint: EndpointPolicy = EndpointPolicy(),
): WakeTry = WakeTry(
    highestScore = scores.maxOrNull() ?: 0f,
    heardSpeech = speech.any { it >= endpoint.speechProbability },
    byStep = WakeSensitivity.offered.associateWith { step -> step.answerFor(scores, phrase) },
)

private fun WakeSensitivity.answerFor(scores: FloatArray, phrase: WakePhrase): WakeStepAnswer {
    val runs = WakeRunCounter(thresholdFor(phrase), detection)
    var wakes = false
    for (score in scores) {
        if (!runs.over(score)) {
            runs.reset()
            continue
        }
        if (runs.complete) {
            wakes = true
            // The loop starts capturing a question here and scores nothing more until it ends, so a try
            // that has already woken is not judged again on what was said after the phrase.
            break
        }
    }
    return WakeStepAnswer(wakes = wakes, longestRun = runs.longest)
}
