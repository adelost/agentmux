package io.agentmux.linkui.product

import io.agentmux.wakeword.WakeChunkReading

/** How long the meter keeps showing the loudest thing it heard before it follows the score down again. */
const val WAKE_PEAK_HOLD_MS = 2_000L

/**
 * WHAT: The peak a wake meter is holding, and when it was set.
 * WHY: lsrc:0 D1, 2026-09-19. The page changed digits twelve times a second and nobody can tune by reading
 * them; a peak that stays up for about two seconds is what makes a near miss visible at all, because the
 * chunk that nearly woke Link is 80 ms long. Time is the loop's own chunk clock, so the hold is measured
 * in listening rather than in wall time and a paused loop cannot decay it.
 */
data class LinkWakePeak(val score: Float = 0f, val atMs: Long = Long.MIN_VALUE / 2) {
    fun after(reading: WakeChunkReading?): LinkWakePeak = when {
        reading == null -> this
        // Anything louder takes the meter and starts its own hold.
        reading.score >= score -> LinkWakePeak(reading.score, reading.atMs)
        // The hold is over, so the meter follows the score down and keeps following it.
        reading.atMs - atMs >= WAKE_PEAK_HOLD_MS -> LinkWakePeak(reading.score, reading.atMs - WAKE_PEAK_HOLD_MS)
        else -> this
    }
}
