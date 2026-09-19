package io.agentmux.wakeword

import java.io.File

/**
 * WHAT: Plays the positive clips, someone saying the phrase and then asking something, and counts how many
 * of them the loop actually woke on, under each detection rule it is given.
 * WHY: A false-wake rate can always be improved by refusing more, so it means nothing on its own.
 * This is the other half of the price, and the half that is the wearer's: a phrase said and not heard.
 * Swedish is counted separately because it is the language the phone is used in.
 *
 * `./gradlew :wakeword:wakePositivesReport -Pclips=<dir> [-Pphrases=hey-jarvis] [-Pdetection=1,2,3] [-Pthreshold=0.5]`
 * The clips are built by `scripts/wake-positives.sh` and are not in the repository.
 */
fun main(args: Array<String>) {
    val named = namedArguments(args)
    val root = File(named["clips"] ?: error("clips=<directory built by scripts/wake-positives.sh> is required"))
    val policies = detectionPolicies(named["detection"])
    val threshold = named["threshold"]?.toFloat()
    val phrases = chosenPhrases(named["phrases"]).map { if (threshold == null) it else it.copy(threshold = threshold) }

    println("clips ${root.absolutePath}")
    val results = phrases.flatMap { phrase ->
        val clips = File(root, phrase.id).listFiles { f: File -> f.extension == "wav" }?.sortedBy { it.name }
            ?: error("no clips for ${phrase.id} under ${root.absolutePath}; run scripts/wake-positives.sh")
        wakeModels(phrase).use { models ->
            SileroSpeechProbability.load(modelBytes("silero_vad.onnx")).use { vad ->
                policies.map { detection -> heard(phrase, models, vad, clips, detection) }
            }
        }
    }
    report(results)
}

/** A clip the loop did not wake on, and how close it came by each of the two measures. */
private data class Missed(val clip: String, val highestScore: Float, val longestRun: Int)

/** One phrase's whole clip set under one rule. */
private data class Positives(
    val phrase: WakePhrase,
    val detection: WakeDetectionPolicy,
    val woke: List<String>,
    val missed: List<Missed>,
) {
    val clips = woke.size + missed.size
    private fun swedish(name: String) = name.startsWith("sv-SE")
    val swedishClips = woke.count(::swedish) + missed.count { swedish(it.clip) }
    val swedishWoke = woke.count(::swedish)
}

private fun heard(
    phrase: WakePhrase,
    models: WakeWordModels,
    vad: SileroSpeechProbability,
    clips: List<File>,
    detection: WakeDetectionPolicy,
): Positives {
    val woke = mutableListOf<String>()
    val missed = mutableListOf<Missed>()
    clips.forEach { clip ->
        val replayed = replay(phrase, models, vad, readPcm16Wav(clip.readBytes()), detection)
        if (replayed.wakes.isEmpty()) {
            missed += Missed(clip.nameWithoutExtension, replayed.highestScore, replayed.longestRun)
        } else {
            woke += clip.nameWithoutExtension
        }
    }
    println(
        "  %-12s run %d threshold %.2f  %d of %d clips woke it".format(
            phrase.id, detection.chunksOverThreshold, phrase.threshold, woke.size, clips.size,
        ),
    )
    return Positives(phrase, detection, woke, missed)
}

private fun report(results: List<Positives>) {
    println()
    println("PHRASES HEARD, by phrase and rule")
    println("%-12s %-6s %-11s %12s %10s".format("phrase", "run", "threshold", "all clips", "Swedish"))
    results.forEach {
        println(
            "%-12s %-6d %-11.2f %12s %10s".format(
                it.phrase.id, it.detection.chunksOverThreshold, it.phrase.threshold,
                "${it.woke.size}/${it.clips}", "${it.swedishWoke}/${it.swedishClips}",
            ),
        )
    }
    println()
    println("EVERY CLIP THAT WAS NOT HEARD, with the highest score it reached")
    results.filter { it.missed.isNotEmpty() }.forEach { positives ->
        positives.missed.forEach { miss ->
            println(
                "%s run %d %s: highest score %.4f of %.2f, longest run %d of %d".format(
                    positives.phrase.id, positives.detection.chunksOverThreshold, miss.clip,
                    miss.highestScore, positives.phrase.threshold, miss.longestRun,
                    positives.detection.chunksOverThreshold,
                ),
            )
        }
    }
}
