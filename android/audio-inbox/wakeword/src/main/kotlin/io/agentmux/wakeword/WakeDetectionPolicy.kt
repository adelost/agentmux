package io.agentmux.wakeword

/**
 * WHAT: What it takes for wake scores to become a question, beyond one number clearing the threshold.
 * WHY: A single 80 ms chunk over the threshold is one model's opinion of one twelfth of a second.
 * Measured 2026-09-19 over 68 minutes with no wake phrase in it and over 48 clips per phrase that do say it
 * (docs/qa/2026-09-19-wake-detection-run): two chunks take the default phrase from 1.76 false wakes an hour
 * to none in that hour, cost four of its 48 clips and no Swedish clip, and delay a real detection by 80 ms.
 * Three buys one more phrase's last false wake and costs two more clips, so two is what ships.
 * The cost of asking for more is in [delayMs] and in the phrase someone said and was not heard saying,
 * so the number here is never changed without both measurements beside each other.
 */
data class WakeDetectionPolicy(val chunksOverThreshold: Int = 2) {
    init {
        require(chunksOverThreshold >= 1) {
            "a question needs at least one chunk at or over the threshold, not $chunksOverThreshold"
        }
    }

    /** How much later than the first chunk over the threshold a question can start. */
    val delayMs: Int = (chunksOverThreshold - 1) * WAKE_CHUNK_MS
}
