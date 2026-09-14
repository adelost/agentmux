package io.agentmux.audioinbox

import io.agentmux.wakeword.EndpointPolicy
import io.agentmux.wakeword.SileroSpeechProbability
import io.agentmux.wakeword.UtteranceEnd
import io.agentmux.wakeword.UtteranceProgress
import io.agentmux.wakeword.WAKE_CHUNK_SAMPLES
import io.agentmux.wakeword.WakeWordDetector

// The phrase's last syllable and the confirmation beep: neither is part of the question.
private const val WAKE_TAIL_CHUNKS = 4

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
    /** The open follow-up window's number, or null when none is open. */
    private val followUpWindow: () -> Int?,
    private val followUpPolicy: EndpointPolicy,
    private val listener: WakeLoopListener,
) {
    @Volatile private var running = true

    fun stop() {
        running = false
    }

    fun run() {
        val chunk = ShortArray(WAKE_CHUNK_SAMPLES)
        var question: QuestionCapture? = null
        var lastFollowUp = followUpWindow() ?: 0
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
            val window = followUpWindow()
            if (window != null && window > lastFollowUp) {
                lastFollowUp = window
                vad.reset()
                question = QuestionCapture(vad, followUpPolicy, skipChunks = 0).also { it.accept(chunk) }
                continue
            }
            if (!detectionAllowed()) continue
            val score = detector.score(chunk)
            if (score >= threshold) {
                listener.onDetected(score)
                vad.reset()
                question = QuestionCapture(vad, policy, skipChunks = WAKE_TAIL_CHUNKS)
            }
        }
    }
}

/** The PCM of one spoken question and its end-of-speech counters. */
private class QuestionCapture(
    private val vad: SileroSpeechProbability,
    private val policy: EndpointPolicy,
    private var skipChunks: Int,
) {
    val startedAtMs = System.currentTimeMillis()
    private val chunks = mutableListOf<ShortArray>()
    private var progress = UtteranceProgress()
    var end = UtteranceEnd.NONE
        private set

    /** True once the question is finished. */
    fun accept(chunk: ShortArray): Boolean {
        if (skipChunks > 0) {
            skipChunks -= 1
            return false
        }
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
