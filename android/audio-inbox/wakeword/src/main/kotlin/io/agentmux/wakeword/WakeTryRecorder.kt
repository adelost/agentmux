package io.agentmux.wakeword

/**
 * A try ends sooner than a question does. A question may pause mid-thought, which is why a capture waits
 * 2.5 s of silence for one (Mattias 2026-09-14); a try is two words and its answer is the page's whole
 * purpose, so it is judged as soon as the phrase has clearly stopped.
 */
val WAKE_TRY_ENDPOINT = EndpointPolicy(trailingSilenceMs = 800)

/** How long a verdict stays up when nothing else is said (lsrc:0 step 8, point 4). */
const val WAKE_TRY_VERDICT_HOLD_MS = 6_000L

/**
 * One finished try on both clocks: [atMs] counts the microphone's own chunks, which is what the hold is
 * measured in, and [wallClockMs] is the wearer's, which is what a row of past tries is read by.
 */
data class RecordedTry(val judged: WakeTry, val atMs: Long, val wallClockMs: Long)

/** What the TRY page can read right now: the live chunk, whether he is speaking, and the tries kept. */
data class WakeTryTrace(
    val latest: WakeChunkReading? = null,
    /** True while an utterance is being collected, which is what clears the last verdict. */
    val speaking: Boolean = false,
    /** Newest first. */
    val tries: List<RecordedTry> = emptyList(),
)

/**
 * The try the page is showing a verdict for, or null for SAY IT NOW. A verdict holds until the next
 * speech starts or [WAKE_TRY_VERDICT_HOLD_MS] of listening, whichever is first: a wearer who says the
 * phrase twice must see the second answer, and one that stayed up would be read as the answer to it.
 */
fun WakeTryTrace.showing(): RecordedTry? {
    if (speaking) return null
    val newest = tries.firstOrNull() ?: return null
    val now = latest?.atMs ?: return newest
    return newest.takeIf { now - it.atMs < WAKE_TRY_VERDICT_HOLD_MS }
}

/**
 * WHAT: The loop's chunk stream turned into tries: one utterance collected from the chunk speech started
 * on until the phrase has clearly stopped, then judged under every step at once.
 * WHY: The TRY page answers for all three steps from ONE utterance, which is only possible because a
 * chunk's score does not depend on the step (see [judgeUnderEveryStep]). The segmenting is the same
 * endpoint rule a question is captured with, so what counts as one thing said is decided in one place.
 *
 * The microphone thread writes this and the page reads it, exactly as [WakeTraceBuffer] is written and
 * read, so both are bounded and neither blocks the other. Nothing here reaches storage.
 */
class WakeTryRecorder(
    private val phrase: WakePhrase,
    private val endpoint: EndpointPolicy = WAKE_TRY_ENDPOINT,
    private val keep: Int = 5,
    /** Taken when a try is judged, so a page can say what time it was and a test can say it too. */
    private val wallClock: () -> Long = System::currentTimeMillis,
) : WakeChunkTrace {
    init { require(keep >= 1) { "a page keeps at least one try, not $keep" } }

    private val lock = Any()
    private var latest: WakeChunkReading? = null
    private val scores = mutableListOf<Float>()
    private val speech = mutableListOf<Float>()
    private var progress: UtteranceProgress? = null
    private val tries = ArrayDeque<RecordedTry>()

    override fun onChunkScored(atMs: Long, score: Float, speechProbability: Float, chunksOverThreshold: Int) {
        synchronized(lock) {
            latest = WakeChunkReading(atMs, score, speechProbability, chunksOverThreshold)
            val collecting = progress ?: begunBy(speechProbability) ?: return
            scores += score
            speech += speechProbability
            val advanced = collecting.advance(speechProbability, endpoint)
            progress = advanced
            if (advanced.end(endpoint) != UtteranceEnd.NONE) finish(atMs)
        }
    }

    /**
     * The loop's own runs are counted against the step in use, and this page answers for all three, so
     * what it heard is read from the chunks themselves and a run tells it nothing it does not have.
     */
    override fun onRunEnded(run: WakeRun) = Unit

    fun read(): WakeTryTrace = synchronized(lock) {
        WakeTryTrace(latest = latest, speaking = progress != null, tries = tries.toList())
    }

    fun clear() {
        synchronized(lock) {
            latest = null
            progress = null
            scores.clear()
            speech.clear()
            tries.clear()
        }
    }

    /** A try begins on the chunk the voice model first calls speech, and never in a quiet room. */
    private fun begunBy(speechProbability: Float): UtteranceProgress? =
        UtteranceProgress().takeIf { speechProbability >= endpoint.speechProbability }

    private fun finish(atMs: Long) {
        val judged = judgeUnderEveryStep(scores.toFloatArray(), speech.toFloatArray(), phrase, endpoint)
        tries.addFirst(RecordedTry(judged, atMs, wallClock()))
        while (tries.size > keep) tries.removeLast()
        scores.clear()
        speech.clear()
        progress = null
    }
}

/** One chunk stream reported to more than one watcher: the TRY page and WAKE DEBUG can both be open. */
class WakeChunkTraceFanout(private val watchers: List<WakeChunkTrace>) : WakeChunkTrace {
    override fun onChunkScored(atMs: Long, score: Float, speechProbability: Float, chunksOverThreshold: Int) =
        watchers.forEach { it.onChunkScored(atMs, score, speechProbability, chunksOverThreshold) }

    override fun onRunEnded(run: WakeRun) = watchers.forEach { it.onRunEnded(run) }
}
