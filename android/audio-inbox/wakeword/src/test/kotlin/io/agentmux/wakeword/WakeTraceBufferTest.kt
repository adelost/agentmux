package io.agentmux.wakeword

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The trace runs for as long as the service does, so what it keeps is bounded and what it shows is the newest. */
class WakeTraceBufferTest {
    private fun run(atMs: Long, refusal: WakeRefusal? = WakeRefusal.NOT_ENOUGH_CHUNKS) =
        WakeRun(atMs = atMs, peakScore = 0.6f, chunksOverThreshold = 1, speechProbability = 0.5f, refusal = refusal)

    @Test
    fun aFreshTraceHasHeardNothing() {
        val trace = WakeTraceBuffer().read()
        assertNull(trace.latest)
        assertEquals(emptyList<WakeRun>(), trace.runs)
    }

    @Test
    fun theNewestRunIsFirstAndTheOldestFallsOffTheEnd() {
        val buffer = WakeTraceBuffer(capacity = 3)
        (1L..5L).forEach { buffer.onRunEnded(run(it * 1_000)) }
        assertEquals(listOf(5_000L, 4_000L, 3_000L), buffer.read().runs.map { it.atMs })
    }

    @Test
    fun theLatestReadingIsTheLastChunkAndItsRun() {
        val buffer = WakeTraceBuffer()
        buffer.onChunkScored(80, 0.1f, 0.2f, 0)
        buffer.onChunkScored(160, 0.7f, 0.9f, 1)
        val latest = buffer.read().latest
        assertEquals(WakeChunkReading(160, 0.7f, 0.9f, 1), latest)
    }

    @Test
    fun clearingLeavesNothingBehind() {
        val buffer = WakeTraceBuffer()
        buffer.onChunkScored(80, 0.9f, 0.9f, 1)
        buffer.onRunEnded(run(80))
        buffer.clear()
        assertEquals(WakeTrace(null, emptyList()), buffer.read())
    }

    @Test
    fun aTraceThatKeepsNothingIsRefusedByName() {
        val refusal = runCatching { WakeTraceBuffer(capacity = 0) }.exceptionOrNull()
        assertEquals("a trace keeps at least one run, not 0", refusal?.message)
    }

    // A run that became a question and one that was refused are told apart by the refusal, not by a flag
    // someone has to remember to set.
    @Test
    fun anAcceptedRunIsTheOneWithoutARefusal() {
        val buffer = WakeTraceBuffer()
        buffer.onRunEnded(run(80, refusal = null))
        buffer.onRunEnded(run(160))
        assertEquals(listOf(false, true), buffer.read().runs.map { it.accepted })
    }
}
