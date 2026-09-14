package io.agentmux.audioinbox

import io.agentmux.wakeword.EndpointPolicy
import io.agentmux.wakeword.SileroSpeechProbability
import io.agentmux.wakeword.UtteranceEnd
import io.agentmux.wakeword.UtteranceProgress
import io.agentmux.wakeword.WAKE_CHUNK_SAMPLES
import io.agentmux.wakeword.WakeWordDetector

private const val PREROLL_CHUNKS = 4

/** What the microphone thread reports to the service's main-thread reducer. */
internal interface WakeLoopListener {
    fun onDetected(score: Float)
    fun onQuestion(end: UtteranceEnd, pcm: ShortArray, startedAtMs: Long)
    fun onSourceStopped()
}

/**
 * WHAT: One microphone thread: score each chunk for the wake word, then capture the question until the VAD says it ended.
 * WHY: A single AudioRecord owner avoids the busy-microphone gap between detection and recording.
 */
internal class WakeListeningLoop(
    private val source: WakePcmSource,
    private val detector: WakeWordDetector,
    private val vad: SileroSpeechProbability,
    private val threshold: Float,
    private val policy: EndpointPolicy,
    private val detectionAllowed: () -> Boolean,
    private val listener: WakeLoopListener,
) {
    @Volatile private var running = true

    fun stop() {
        running = false
    }

    fun run() {
        val chunk = ShortArray(WAKE_CHUNK_SAMPLES)
        val preroll = ArrayDeque<ShortArray>()
        var question: QuestionCapture? = null
        while (running) {
            if (!source.read(chunk)) {
                if (running) listener.onSourceStopped()
                return
            }
            val capturing = question
            if (capturing != null) {
                if (capturing.accept(chunk)) {
                    listener.onQuestion(capturing.end, capturing.pcm(), capturing.startedAtMs)
                    question = null
                    detector.reset()
                }
                continue
            }
            preroll.addLast(chunk.copyOf())
            while (preroll.size > PREROLL_CHUNKS) preroll.removeFirst()
            if (!detectionAllowed()) continue
            val score = detector.score(chunk)
            if (score >= threshold) {
                listener.onDetected(score)
                vad.reset()
                question = QuestionCapture(preroll.toList(), vad, policy)
                preroll.clear()
            }
        }
    }
}

/** The PCM of one spoken question and its end-of-speech counters. */
private class QuestionCapture(
    preroll: List<ShortArray>,
    private val vad: SileroSpeechProbability,
    private val policy: EndpointPolicy,
) {
    val startedAtMs = System.currentTimeMillis()
    private val chunks = preroll.toMutableList()
    private var progress = UtteranceProgress()
    var end = UtteranceEnd.NONE
        private set

    /** True once the question is finished. */
    fun accept(chunk: ShortArray): Boolean {
        chunks += chunk.copyOf()
        progress = progress.advance(vad.probability(chunk), policy)
        end = progress.end(policy)
        return end != UtteranceEnd.NONE
    }

    fun pcm(): ShortArray {
        val all = ShortArray(chunks.sumOf { it.size })
        var offset = 0
        chunks.forEach { it.copyInto(all, offset); offset += it.size }
        return all
    }
}
