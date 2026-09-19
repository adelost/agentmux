package io.agentmux.linkui.product

import io.agentmux.wakeword.WakeChunkReading
import org.junit.Assert.assertEquals
import org.junit.Test

/** lsrc:0 D1: the meter's reason to exist is that an 80 ms near miss stays visible long enough to read. */
class LinkWakePeakTest {
    private fun reading(atMs: Long, score: Float) = WakeChunkReading(atMs, score, 0.9f, 0)

    @Test
    fun aLouderChunkTakesTheMeterAtOnce() {
        val peak = LinkWakePeak().after(reading(80, 0.12f)).after(reading(160, 0.44f))
        assertEquals(0.44f, peak.score, 0f)
    }

    @Test
    fun theNearMissStaysUpForTheWholeHold() {
        var peak = LinkWakePeak().after(reading(1_000, 0.45f))
        listOf(1_080L, 1_500L, 2_900L).forEach { at ->
            peak = peak.after(reading(at, 0.02f))
            assertEquals("at $at", 0.45f, peak.score, 0f)
        }
    }

    @Test
    fun afterTheHoldItFollowsTheScoreDownRatherThanHoldingTheNextOne() {
        var peak = LinkWakePeak().after(reading(1_000, 0.45f))
        peak = peak.after(reading(1_000 + WAKE_PEAK_HOLD_MS, 0.30f))
        assertEquals(0.30f, peak.score, 0f)
        // The second lower chunk must move it too: a meter that re-held here would never come down.
        peak = peak.after(reading(1_000 + WAKE_PEAK_HOLD_MS + 80, 0.05f))
        assertEquals(0.05f, peak.score, 0f)
    }

    @Test
    fun aSecondNearMissRestartsTheHold() {
        var peak = LinkWakePeak().after(reading(1_000, 0.45f))
        peak = peak.after(reading(2_000, 0.60f))
        peak = peak.after(reading(3_900, 0.01f))
        assertEquals(0.60f, peak.score, 0f)
    }

    @Test
    fun nothingHeardYetLeavesTheMeterWhereItWas() {
        val peak = LinkWakePeak(0.4f, 10).after(null)
        assertEquals(LinkWakePeak(0.4f, 10), peak)
    }
}
