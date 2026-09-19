package io.agentmux.wakeword

/** The newest reading of both models and of the run in progress, or nothing yet. */
data class WakeChunkReading(
    val atMs: Long,
    val score: Float,
    val speechProbability: Float,
    val chunksOverThreshold: Int,
)

/**
 * One ended run and the wall clock it reached the buffer at.
 *
 * The loop counts in chunks from the microphone it opened, which is the only clock a detector can have and
 * the right one for measuring; a wearer reading a page needs the other one, because "9 s" does not say
 * since what (lsrc:0 D2, 2026-09-19). The stamp is taken here, on arrival, rather than in the loop, so the
 * loop stays free of a clock it would otherwise have to be given.
 */
data class TracedRun(val run: WakeRun, val wallClockMs: Long)

/** What a watcher can read right now: the live chunk, the run in progress and the runs that ended. */
data class WakeTrace(val latest: WakeChunkReading?, val runs: List<TracedRun>)

/**
 * WHAT: A bounded in-memory trace: the newest chunk reading and the last [capacity] runs, newest first.
 * WHY: The microphone thread writes it 12.5 times a second and a page reads it; neither may block the other,
 * and nothing is written to storage unless the wearer asks for it. Nothing here grows without a bound,
 * because this runs for as long as the service does.
 */
class WakeTraceBuffer(
    private val capacity: Int = 50,
    /** Taken when a run arrives, so a page can say what time it was and a test can say it too. */
    private val wallClock: () -> Long = System::currentTimeMillis,
) : WakeChunkTrace {
    init { require(capacity >= 1) { "a trace keeps at least one run, not $capacity" } }

    private val lock = Any()
    private var latest: WakeChunkReading? = null
    private val runs = ArrayDeque<TracedRun>()

    override fun onChunkScored(atMs: Long, score: Float, speechProbability: Float, chunksOverThreshold: Int) {
        synchronized(lock) {
            latest = WakeChunkReading(atMs, score, speechProbability, chunksOverThreshold)
        }
    }

    override fun onRunEnded(run: WakeRun) {
        val at = wallClock()
        synchronized(lock) {
            runs.addFirst(TracedRun(run, at))
            while (runs.size > capacity) runs.removeLast()
        }
    }

    /** One consistent picture for a reader on another thread. */
    fun read(): WakeTrace = synchronized(lock) { WakeTrace(latest, runs.toList()) }

    fun clear() {
        synchronized(lock) {
            latest = null
            runs.clear()
        }
    }
}
