package io.agentmux.wakeword

import java.io.File

/**
 * WHAT: Streams a directory of 16 kHz mono WAVs through the real [WakeListeningLoop] and reports how often
 * each phrase wakes on audio that contains no wake word, under each detection rule it is given.
 * WHY: The rate a wake word fires at cannot be read off the code, and the number it replaced
 * (wakeword/README.md before 2026-09-19) was 5.9 minutes of synthesised Swedish speech, which cannot show
 * one false wake per hour. Nothing here is a fixture: the corpus is broadcast audio and Link's own replies,
 * kept out of the repository and rebuilt by `scripts/wake-corpus.sh`.
 *
 * `./gradlew :wakeword:wakeCorpusReport -Pcorpus=<dir> [-Ptraces=<dir>] [-Pphrases=..] [-Pdetection=1,2,3] [-Pthreshold=0.78]`
 * Every number it prints comes from the loop the phone runs; this file only feeds it and counts.
 */
fun main(args: Array<String>) {
    val named = namedArguments(args)
    val corpus = File(named["corpus"] ?: error("corpus=<directory of 16 kHz mono WAVs> is required"))
    val traceDir = named["traces"]?.let(::File)
    val threshold = named["threshold"]?.toFloat()
    val phrases = chosenPhrases(named["phrases"]).map { if (threshold == null) it else it.copy(threshold = threshold) }
    val policies = detectionPolicies(named["detection"])
    val wavs = corpus.listFiles { f: File -> f.extension == "wav" }?.sortedBy { it.name }
        ?: error("no directory at ${corpus.absolutePath}")
    require(wavs.isNotEmpty()) { "no .wav files in ${corpus.absolutePath}" }

    println("corpus ${corpus.absolutePath}")
    val results = phrases.flatMap { phrase ->
        wakeModels(phrase).use { models ->
            SileroSpeechProbability.load(modelBytes("silero_vad.onnx")).use { vad ->
                policies.flatMap { detection ->
                    wavs.map { wav -> measure(phrase, models, vad, wav, detection, traceDir) }
                }
            }
        }
    }
    report(results)
}

/** One corpus file heard by one phrase under one rule. */
private data class CorpusRun(
    val phrase: WakePhrase,
    val detection: WakeDetectionPolicy,
    val source: String,
    val seconds: Double,
    val replayed: Replayed,
)

private fun measure(
    phrase: WakePhrase,
    models: WakeWordModels,
    vad: SileroSpeechProbability,
    wav: File,
    detection: WakeDetectionPolicy,
    traceDir: File?,
): CorpusRun {
    val samples = readPcm16Wav(wav.readBytes())
    val started = System.nanoTime()
    val replayed = replay(
        phrase, models, vad, samples, detection,
        traceDir?.resolve(phrase.id)?.resolve("run${detection.chunksOverThreshold}")?.resolve("${wav.nameWithoutExtension}.tsv"),
    )
    val seconds = samples.size.toDouble() / WAKE_SAMPLE_RATE
    println(
        "  %-12s run %d %-32s %5.1f min  %d wake(s)  in %.0f s".format(
            phrase.id, detection.chunksOverThreshold, wav.name, seconds / 60, replayed.wakes.size,
            (System.nanoTime() - started) / 1e9,
        ),
    )
    return CorpusRun(phrase, detection, wav.nameWithoutExtension, seconds, replayed)
}

private fun report(results: List<CorpusRun>) {
    println()
    println("FALSE WAKES PER HOUR, by phrase and rule")
    println("%-12s %-6s %-10s %8s %7s %10s %12s".format("phrase", "run", "threshold", "minutes", "wakes", "per hour", "captured s"))
    results.groupBy { it.phrase to it.detection }.forEach { (key, runs) ->
        val (phrase, detection) = key
        val minutes = runs.sumOf { it.seconds } / 60
        val wakes = runs.sumOf { it.replayed.wakes.size }
        println(
            "%-12s %-6d %-10.2f %8.1f %7d %10.2f %12.0f".format(
                phrase.id, detection.chunksOverThreshold, phrase.threshold, minutes, wakes, wakes / (minutes / 60),
                runs.sumOf { it.replayed.capturedMs } / 1_000.0,
            ),
        )
    }
    println()
    println("EVERY WAKE, with the second around it")
    results.filter { it.replayed.wakes.isNotEmpty() }.forEach { run ->
        run.replayed.wakes.forEach { wake ->
            println(
                "%s run %d %s at %.1f s, score %.4f, the VAD called that chunk %.2f speech".format(
                    run.phrase.id, run.detection.chunksOverThreshold, run.source,
                    wake.atMs / 1_000.0, wake.score, wake.speech,
                ),
            )
            println("  " + wake.around.joinToString(" ") { "%.2f".format(it) })
        }
    }
}
