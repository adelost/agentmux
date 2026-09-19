package io.agentmux.wakeword

/** The newest reading of both models and of the run in progress, or nothing yet. */
data class WakeChunkReading(
    val atMs: Long,
    val score: Float,
    val speechProbability: Float,
    val chunksOverThreshold: Int,
)

/** What a watcher can read right now: the live chunk, the run in progress and the runs that ended. */
data class WakeTrace(val latest: WakeChunkReading?, val runs: List<WakeRun>)

/**
 * WHAT: A bounded in-memory trace: the newest chunk reading and the last [capacity] runs, newest first.
 * WHY: The microphone thread writes it 12.5 times a second and a page reads it; neither may block the other,
 * and nothing is written to storage unless the wearer asks for it. Nothing here grows without a bound,
 * because this runs for as long as the service does.
 */
class WakeTraceBuffer(private val capacity: Int = 50) : WakeChunkTrace {
    init { require(capacity >= 1) { "a trace keeps at least one run, not $capacity" } }

    private val lock = Any()
    private var latest: WakeChunkReading? = null
    private val runs = ArrayDeque<WakeRun>()

    override fun onChunkScored(atMs: Long, score: Float, speechProbability: Float, chunksOverThreshold: Int) {
        synchronized(lock) {
            latest = WakeChunkReading(atMs, score, speechProbability, chunksOverThreshold)
        }
    }

    override fun onRunEnded(run: WakeRun) {
        synchronized(lock) {
            runs.addFirst(run)
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
