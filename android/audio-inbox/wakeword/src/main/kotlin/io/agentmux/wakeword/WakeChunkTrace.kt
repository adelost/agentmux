package io.agentmux.wakeword

/** Why a run of chunks at or over the threshold did not become a question. */
enum class WakeRefusal {
    /** Shorter than [WakeDetectionPolicy.chunksOverThreshold]: one model's opinion of one twelfth of a second. */
    NOT_ENOUGH_CHUNKS,

    /**
     * Long enough, and nobody was listening for an answer: the TRY page holds the loop while it judges
     * what it hears, so a run that ended there would have woken Link and was never asked to.
     */
    NOT_ASKED,
}

/** One run of chunks at or over the threshold, and what the rules did with it. */
data class WakeRun(
    val atMs: Long,
    val peakScore: Float,
    val chunksOverThreshold: Int,
    val speechProbability: Float,
    val refusal: WakeRefusal?,
) {
    val accepted: Boolean get() = refusal == null
}

/**
 * WHAT: Every 80 ms chunk the loop scores while it waits for the phrase, and every run of chunks that
 * reached the threshold, accepted or refused.
 * WHY: A wake word that fires too often cannot be tuned from the wakes alone; the near misses are where
 * the threshold and the run length are chosen, and a wearer who says the phrase and is not heard has no
 * other way to find out why. Watching costs one extra VAD call per chunk, so nothing traces unless someone
 * asked (Mattias 2026-09-19: "att man ser när den hör det eller inte hör det").
 */
interface WakeChunkTrace {
    /**
     * [atMs] counts from the first chunk this microphone delivered, not from the wall clock.
     * [chunksOverThreshold] counts this chunk in, and is zero as soon as one falls back under.
     */
    fun onChunkScored(atMs: Long, score: Float, speechProbability: Float, chunksOverThreshold: Int)

    /** A run ended, either because it became a question or because a chunk fell back under the threshold. */
    fun onRunEnded(run: WakeRun)
}
