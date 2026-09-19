package io.agentmux.wakeword

import java.io.File

/**
 * WHAT: Streams a directory of 16 kHz mono WAVs through the real [WakeListeningLoop] and reports how often
 * each phrase wakes on audio that contains no wake word.
 * WHY: The rate a wake word fires at cannot be read off the code, and the only published number for it
 * (wakeword/README.md) is 5.9 minutes of synthesised Swedish speech, which cannot show one false wake per hour.
 * Nothing here is a fixture: the corpus is broadcast audio and Link's own replies, kept out of the repository.
 *
 * Run it with `./gradlew :wakeword:wakeCorpusReport -Pcorpus=<dir> -Ptraces=<dir>`.
 * Every number it prints comes from the loop the phone runs; this file only feeds it and counts.
 */
fun main(args: Array<String>) {
    val named = args.associate { arg ->
        val equals = arg.indexOf('=')
        require(equals > 0) { "arguments are name=value, not '$arg'" }
        arg.substring(0, equals) to arg.substring(equals + 1)
    }
    val corpus = File(named["corpus"] ?: error("corpus=<directory of 16 kHz mono WAVs> is required"))
    val traceDir = named["traces"]?.let(::File)
    val phrases = named["phrases"]?.split(",")?.map { id ->
        WakePhrases.byId(id) ?: error("unknown phrase id '$id'; this build offers ${WakePhrases.offered.map { it.id }}")
    } ?: WakePhrases.offered
    val wavs = corpus.listFiles { f: File -> f.extension == "wav" }?.sortedBy { it.name }
        ?: error("no directory at ${corpus.absolutePath}")
    require(wavs.isNotEmpty()) { "no .wav files in ${corpus.absolutePath}" }

    println("corpus ${corpus.absolutePath}")
    val results = phrases.flatMap { phrase ->
        wakeModels(phrase).use { models ->
            SileroSpeechProbability.load(modelBytes("silero_vad.onnx")).use { vad ->
                wavs.map { wav -> measure(phrase, models, vad, wav, traceDir) }
            }
        }
    }
    report(results)
}

/** One corpus file heard by one phrase. */
private data class CorpusRun(
    val phrase: WakePhrase,
    val source: String,
    val seconds: Double,
    val wakes: List<Wake>,
    val capturedMs: Long,
)

/** One false wake: when it fired, how loud the score was, what the VAD thought of that chunk, and the second on either side. */
private data class Wake(val atMs: Long, val score: Float, val speech: Float, val around: List<Pair<Long, Float>>)

private fun measure(
    phrase: WakePhrase,
    models: WakeWordModels,
    vad: SileroSpeechProbability,
    wav: File,
    traceDir: File?,
): CorpusRun {
    val samples = readPcm16Wav(wav.readBytes())
    val detector = WakeWordDetector(models)
    vad.reset()
    val trace = RecordedTrace(traceDir?.resolve(phrase.id)?.also { it.mkdirs() }?.resolve("${wav.nameWithoutExtension}.tsv"))
    val heard = CountedWakes(trace)
    val started = System.nanoTime()
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
        policy = EndpointPolicy(),
        detectionAllowed = { true },
        listener = heard,
        trace = trace,
    ).run()
    trace.close()
    val seconds = samples.size.toDouble() / WAKE_SAMPLE_RATE
    println(
        "  %-14s %-32s %5.1f min  %d wake(s)  in %.0f s".format(
            phrase.id, wav.name, seconds / 60, heard.wakes.size, (System.nanoTime() - started) / 1e9,
        ),
    )
    return CorpusRun(phrase, wav.nameWithoutExtension, seconds, heard.wakes, heard.capturedMs)
}

/** The corpus as a microphone: the same 80 ms chunks, with no wall clock to wait for. */
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

/** Keeps every chunk's two scores, so a wake can be read with the second before and after it. */
private class RecordedTrace(file: File?) : WakeChunkTrace {
    private val rows = mutableListOf<Triple<Long, Float, Float>>()
    private val writer = file?.bufferedWriter()?.also { it.write("ms\tscore\tspeech\n") }
    /** The chunk the loop is on: the loop traces a chunk before it decides about it. */
    var atMs = 0L
        private set
    var speech = 0f
        private set

    override fun onChunkScored(atMs: Long, score: Float, speechProbability: Float) {
        this.atMs = atMs
        speech = speechProbability
        rows += Triple(atMs, score, speechProbability)
        writer?.write("%d\t%.4f\t%.4f\n".format(atMs, score, speechProbability))
    }

    fun around(atMs: Long): List<Pair<Long, Float>> =
        rows.filter { it.first >= atMs - 1_000 && it.first <= atMs + 1_000 }.map { it.first to it.second }

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

private fun report(results: List<CorpusRun>) {
    println()
    println("FALSE WAKES, one line per phrase and source")
    println("%-14s %-32s %8s %7s %9s %12s".format("phrase", "source", "minutes", "wakes", "per hour", "captured s"))
    results.forEach { run ->
        println(
            "%-14s %-32s %8.1f %7d %9.2f %12.0f".format(
                run.phrase.id, run.source, run.seconds / 60, run.wakes.size,
                run.wakes.size / (run.seconds / 3_600), run.capturedMs / 1_000.0,
            ),
        )
    }
    println()
    println("TOTAL per phrase")
    results.groupBy { it.phrase }.forEach { (phrase, runs) ->
        val minutes = runs.sumOf { it.seconds } / 60
        val wakes = runs.sumOf { it.wakes.size }
        println(
            "%-14s threshold %.2f  %.1f min  %d wake(s)  %.2f per hour  %.0f s of the room sent".format(
                phrase.id, phrase.threshold, minutes, wakes, wakes / (minutes / 60), runs.sumOf { it.capturedMs } / 1_000.0,
            ),
        )
    }
    val fired = results.filter { it.wakes.isNotEmpty() }
    if (fired.isEmpty()) return
    println()
    println("EVERY WAKE, with the second around it")
    fired.forEach { run ->
        run.wakes.forEach { wake ->
            println(
                "%s %s at %.1f s, score %.4f, the VAD called that chunk %.2f speech".format(
                    run.phrase.id, run.source, wake.atMs / 1_000.0, wake.score, wake.speech,
                ),
            )
            println("  " + wake.around.joinToString(" ") { "%.2f".format(it.second) })
        }
    }
}
