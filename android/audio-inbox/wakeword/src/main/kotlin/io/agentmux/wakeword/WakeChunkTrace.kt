package io.agentmux.wakeword

/**
 * WHAT: Every 80 ms chunk the loop scores while it waits for the phrase, with what the two models said about it.
 * WHY: A wake word that fires too often cannot be tuned from the wakes alone; the near misses are where the
 * threshold, the run length and the speech floor are chosen. Watching costs one extra VAD call per chunk,
 * so nothing traces unless someone asked (Mattias 2026-09-19: "att man ser när den hör det eller inte hör det").
 */
interface WakeChunkTrace {
    /** [atMs] counts from the first chunk this microphone delivered, not from the wall clock. */
    fun onChunkScored(atMs: Long, score: Float, speechProbability: Float)
}
