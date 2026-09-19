package io.agentmux.wakeword

import java.io.File

/**
 * WHAT: Runs one WAV through the real [WakeListeningLoop] and hands back every wake it produced.
 * WHY: Both measurements, the false wakes in an hour of radio and the phrases the positive clips say out
 * loud, have to be the same loop under the same rule, or the two numbers cannot be put beside each other.
 */
internal fun replay(
    phrase: WakePhrase,
    models: WakeWordModels,
    vad: SileroSpeechProbability,
    samples: ShortArray,
    detection: WakeDetectionPolicy,
    traceFile: File? = null,
): Replayed {
    val detector = WakeWordDetector(models)
    vad.reset()
    val trace = RecordedTrace(traceFile, phrase.threshold)
    val heard = CountedWakes(trace)
    WakeListeningLoop(
        source = WavChunks(samples),
        detector = object : WakeChunkScorer {
            override fun score(chunk: ShortArray) = detector.score(chunk)
            override fun reset() = detector.reset()
        },
        vad = object : SpeechChunkProbability {
            override fun probability(chunk: ShortArray) = vad.probability(chunk)
            override fun reset() = vad.reset()
        },
        threshold = phrase.threshold,
        endpoint = EndpointPolicy(),
        detection = detection,
        detectionAllowed = { true },
        listener = heard,
        trace = trace,
    ).run()
    trace.close()
    return Replayed(heard.wakes, heard.capturedMs, trace.highest, trace.longestRun, trace.refusedRuns)
}

internal data class Replayed(
    val wakes: List<Wake>,
    val capturedMs: Long,
    val highestScore: Float,
    /** The most chunks in a row that were at or over the threshold: what a longer rule would have needed. */
    val longestRun: Int,
    /** How many runs reached the threshold and were refused for being too short. */
    val refusedRuns: Int,
)

/** One wake: when it fired, its score, what the VAD thought of that chunk, and the second on either side. */
internal data class Wake(val atMs: Long, val score: Float, val speech: Float, val around: List<Float>)

/** A WAV as a microphone: the same 80 ms chunks, with no wall clock to wait for. */
private class WavChunks(private val samples: ShortArray) : WakePcmSource {
    private var offset = 0
    override fun read(chunk: ShortArray): Boolean {
        if (offset + chunk.size > samples.size) return false
        samples.copyInto(chunk, 0, offset, offset + chunk.size)
        offset += chunk.size
        return true
    }
    override fun close() = Unit
}

/** Keeps every waiting chunk's two scores, so a wake can be read with the second before and after it. */
private class RecordedTrace(file: File?, private val threshold: Float) : WakeChunkTrace {
    private val rows = mutableListOf<Triple<Long, Float, Float>>()
    private val writer = file?.also { it.parentFile?.mkdirs() }?.bufferedWriter()?.also { it.write("ms\tscore\tspeech\n") }
    /** The chunk the loop is on: it traces a chunk before it decides about it. */
    var atMs = 0L
        private set
    var speech = 0f
        private set
    var highest = 0f
        private set
    var longestRun = 0
        private set
    /** Runs that reached the threshold and were refused for being too short: the corpus's near misses. */
    var refusedRuns = 0
        private set
    private var run = 0

    override fun onChunkScored(atMs: Long, score: Float, speechProbability: Float, chunksOverThreshold: Int) {
        this.atMs = atMs
        speech = speechProbability
        if (score > highest) highest = score
        run = if (score >= threshold) run + 1 else 0
        if (run > longestRun) longestRun = run
        rows += Triple(atMs, score, speechProbability)
        writer?.write("%d\t%.4f\t%.4f\n".format(atMs, score, speechProbability))
    }

    override fun onRunEnded(run: WakeRun) {
        if (!run.accepted) refusedRuns += 1
    }

    fun around(atMs: Long): List<Float> =
        rows.filter { it.first >= atMs - 1_000 && it.first <= atMs + 1_000 }.map { it.second }

    fun close() = writer?.close()
}

/** Every wake the loop reported, and how long its questions held the microphone afterwards. */
private class CountedWakes(private val trace: RecordedTrace) : WakeLoopListener {
    val wakes = mutableListOf<Wake>()
    var capturedMs = 0L
        private set

    override fun onDetected(score: Float) {
        wakes += Wake(trace.atMs, score, trace.speech, trace.around(trace.atMs))
    }
    override fun onHearing(hearing: WakeHearing) = Unit
    override fun onQuestion(end: UtteranceEnd, pcm: ShortArray, startedAtMs: Long) {
        capturedMs += pcm.size.toLong() * 1_000 / WAKE_SAMPLE_RATE
    }
    override fun onSourceStopped() = Unit
}

/** `detection=1,2,3` on a report's command line: the rule lengths to put beside each other. */
internal fun detectionPolicies(spec: String?): List<WakeDetectionPolicy> =
    (spec?.split(",")?.map { it.trim().toInt() } ?: listOf(1)).map(::WakeDetectionPolicy)

/** `phrases=hey-jarvis,alexa`, or every phrase this build offers. */
internal fun chosenPhrases(spec: String?): List<WakePhrase> =
    spec?.split(",")?.map { id ->
        WakePhrases.byId(id) ?: error("unknown phrase id '$id'; this build offers ${WakePhrases.offered.map { it.id }}")
    } ?: WakePhrases.offered

/** Arguments are `name=value`, so nothing shifts when one is left out. */
internal fun namedArguments(args: Array<String>): Map<String, String> = args.associate { arg ->
    val equals = arg.indexOf('=')
    require(equals > 0) { "arguments are name=value, not '$arg'" }
    arg.substring(0, equals) to arg.substring(equals + 1)
}
