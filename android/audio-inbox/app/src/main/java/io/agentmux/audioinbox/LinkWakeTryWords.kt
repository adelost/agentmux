package io.agentmux.audioinbox

import io.agentmux.linkui.product.wakeSensitivityWord
import io.agentmux.wakeword.RecordedTry
import io.agentmux.wakeword.WakePhrase
import io.agentmux.wakeword.WakeSensitivity
import io.agentmux.wakeword.WakeTry
import io.agentmux.wakeword.WakeTryVerdict
import java.time.ZoneId

/**
 * WHAT: Everything the TRY page says in words, away from the pixels that show it.
 * WHY: The page's whole job is to answer a question a wearer asked out loud, so the answer is the part
 * worth testing, and none of it needs a screen to be read. The verdicts and the step answers come from
 * `:wakeword`, which judged the try; what is here is only which words say it.
 */

/** One count and its noun, because "1 chunk(s)" is not something anyone says out loud. */
internal fun chunkCount(chunks: Int): String = if (chunks == 1) "1 chunk" else "$chunks chunks"

/** The four answers the page can give, in the words the wearer reads. No digits: point 7. */
internal fun wakeTryVerdictWords(verdict: WakeTryVerdict): String = when (verdict) {
    WakeTryVerdict.SAY_IT_NOW -> "SAY IT NOW"
    WakeTryVerdict.WOULD_WAKE -> "WOULD WAKE"
    WakeTryVerdict.HEARD_SPEECH_NOT_THE_PHRASE -> "HEARD SPEECH, NOT THE PHRASE"
    WakeTryVerdict.NOT_HEARD -> "NOT HEARD"
}

/** What a step would have done with the try being shown, or nothing yet asked of it. */
internal fun wakeTryStepWord(showing: RecordedTry?, step: WakeSensitivity): String =
    when (showing?.judged?.byStep?.getValue(step)?.wakes) {
        null -> "··"
        true -> "WAKES"
        false -> "NO"
    }

/**
 * The one line under the verdict, in plain words: why it says what it says, and what to do about it.
 * A refusal names the step that refused it and the eagerest step that would not have, because "try
 * EAGER" is the only thing on this page a wearer can act on.
 */
internal fun wakeTryWhy(showing: RecordedTry?, step: WakeSensitivity, phrase: WakePhrase): String {
    val judged = showing?.judged ?: return "Listening · nothing is sent"
    val answer = judged.byStep.getValue(step)
    if (answer.wakes) return "Heard for ${chunkCount(answer.longestRun)} in a row"
    if (judged.verdictFor(step, phrase) == WakeTryVerdict.HEARD_SPEECH_NOT_THE_PHRASE) {
        return "Heard you, but nothing in it sounded like the phrase"
    }
    val needs = "${wakeSensitivityWord(step)} needs ${"%.2f".format(step.thresholdFor(phrase))} " +
        timesWord(step.detection.chunksOverThreshold)
    // The step closest to the one he is on, not the eagerest one there is: the advice is the
    // smallest move that would have heard him.
    val nearest = wakeTryWakingSteps(judged).lastOrNull()
    return when {
        nearest != null -> "$needs · try ${wakeSensitivityWord(nearest)}"
        answer.longestRun == 0 -> "$needs · this one never reached it"
        else -> "$needs · this one reached it ${timesWord(answer.longestRun)}"
    }
}

/**
 * One past try in one line: the wearer's clock, the peak the models gave it and what it would have done.
 * The clock is the same one WAKE DEBUG stamps a run with, because "9 s" does not say since what.
 */
internal fun wakeTryLine(recorded: RecordedTry, zone: ZoneId = ZoneId.systemDefault()): String =
    "${runClock(recorded.wallClockMs, zone)}  ${"%.2f".format(recorded.judged.highestScore)}  " +
        wakeTrySummary(recorded.judged)

/**
 * Which steps a try would have woken, in one clause. A step that wakes is also woken by every eagerer
 * step, measured: STRICT asks for a higher threshold and a longer run than NORMAL, and NORMAL than
 * EAGER, so the answer is always the eagerest steps and the clause can simply name them.
 */
internal fun wakeTrySummary(judged: WakeTry): String {
    val wakes = wakeTryWakingSteps(judged)
    return when {
        wakes.isEmpty() -> "no step wakes"
        wakes.size == WakeSensitivity.offered.size -> "wakes on all three"
        wakes.size == 1 -> "only ${wakeSensitivityWord(wakes.single())}"
        else -> "only ${wakes.joinToString(" and ") { wakeSensitivityWord(it) }}"
    }
}

/** The steps that would wake on this try, the eagerest first, which is the order they are read in. */
private fun wakeTryWakingSteps(judged: WakeTry): List<WakeSensitivity> =
    WakeSensitivity.offered.reversed().filter { judged.byStep.getValue(it).wakes }

private fun timesWord(times: Int): String = when (times) {
    1 -> "once"
    2 -> "twice"
    3 -> "three times"
    else -> "$times times"
}
