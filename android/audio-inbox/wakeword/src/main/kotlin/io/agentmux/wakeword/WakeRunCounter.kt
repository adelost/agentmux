package io.agentmux.wakeword

/**
 * WHAT: The one rule a chunk score is judged by, as a counter over a stream of them.
 *
 * A run is chunks IN A ROW at or over the threshold; the run becomes a question once it is as long as the
 * detection policy asks. A chunk under the threshold breaks the run rather than shortening it, which is the
 * whole reason the rule exists: every false wake measured over 68 minutes of radio was a single chunk spike
 * with its neighbours at 0.07 to 0.22.
 *
 * WHY IT IS A CLASS AND NOT THREE LOOPS: the rule had two copies before row 217, one inlined in
 * [WakeListeningLoop] and one in the replay report's own trace recorder, and the TRY page would have been a
 * third. Three copies of one rule is three places for it to drift, and the page's whole promise is that the
 * step it shows is the step the loop would use. Now the loop counts with this, a watcher counts its near
 * misses with this, and [judgeUnderEveryStep] folds a recorded utterance through one of these per step.
 *
 * The caller owns the reset, exactly as the loop does: a run that ends has to be READ before it is cleared.
 */
class WakeRunCounter(
    private val threshold: Float,
    private val policy: WakeDetectionPolicy,
) {
    /** Chunks in the run so far; zero between runs. */
    var length: Int = 0
        private set

    /** The highest score in the run so far; zero between runs. */
    var peak: Float = 0f
        private set

    /** The longest run this counter has seen, which is what a near miss is measured by. */
    var longest: Int = 0
        private set

    /** True when [score] is at or over the threshold, and then the run has grown by it. */
    fun over(score: Float): Boolean {
        if (score < threshold) return false
        length += 1
        if (length > longest) longest = length
        if (score > peak) peak = score
        return true
    }

    /** True once the run is as long as the policy asks: the moment a question may start. */
    val complete: Boolean get() = length >= policy.chunksOverThreshold

    /** Ends the run. The caller reads [length] and [peak] first if it has to report them. */
    fun reset() {
        length = 0
        peak = 0f
    }
}
