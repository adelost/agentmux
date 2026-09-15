package io.agentmux.audioinbox

import io.agentmux.wakeword.EndpointPolicy
import io.agentmux.wakeword.UtteranceEnd
import io.agentmux.wakeword.UtteranceProgress
import io.agentmux.wakeword.WAKE_CHUNK_SAMPLES
import io.agentmux.wakeword.WakeHearing

// The phrase's last syllable and the confirmation beep: neither is part of the question.
private const val WAKE_TAIL_CHUNKS = 4

/** What the microphone thread reports to the service's main-thread reducer. */
internal interface WakeLoopListener {
    fun onDetected(score: Float)
    /** Every captured chunk of a question: its voice level and the countdown to sending. */
    fun onHearing(hearing: WakeHearing)
    fun onQuestion(end: UtteranceEnd, pcm: ShortArray, startedAtMs: Long)
    fun onSourceStopped()
}

/** The wake-word model as the loop needs it: a score per chunk and a reset between questions. */
internal interface WakeChunkScorer {
    fun score(chunk: ShortArray): Float
    fun reset()
}

/** The voice-activity model as the loop needs it. */
internal interface SpeechChunkProbability {
    fun probability(chunk: ShortArray): Float
    fun reset()
}

/**
 * WHAT: One microphone thread: score each chunk for the wake word, then capture the question until the VAD says it ended.
 * WHY: A single AudioRecord owner avoids the busy-microphone gap between detection and recording.
 * A question only ever starts from a detection (Mattias 2026-09-15: "vill man ha nåt mer så säger man ... wake up-ordet igen").
 */
internal class WakeListeningLoop(
    private val source: WakePcmSource,
    private val detector: WakeChunkScorer,
    private val vad: SpeechChunkProbability,
    private val threshold: Float,
    private val policy: EndpointPolicy,
    private val detectionAllowed: () -> Boolean,
    private val listener: WakeLoopListener,
) {
    @Volatile private var running = true
    @Volatile private var cancelRequested = false

    fun stop() {
        running = false
    }

    /** Drops the question being heard at the next chunk; nothing of it reaches [WakeLoopListener.onQuestion]. */
    fun cancelQuestion() {
        cancelRequested = true
    }

    fun run() {
        val chunk = ShortArray(WAKE_CHUNK_SAMPLES)
        var question: QuestionCapture? = null
        while (running) {
            if (!source.read(chunk)) {
                if (running) listener.onSourceStopped()
                return
            }
            if (cancelRequested) {
                cancelRequested = false
                if (question != null) {
                    question = null
                    detector.reset()
                    vad.reset()
                }
            }
            val capturing = question
            if (capturing != null) {
                val finished = capturing.accept(chunk)
                capturing.hearing?.let(listener::onHearing)
                if (finished) {
                    listener.onQuestion(capturing.end, capturing.pcm(), capturing.startedAtMs)
                    question = null
                    detector.reset()
                }
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
    private val vad: SpeechChunkProbability,
    private val policy: EndpointPolicy,
    private var skipChunks: Int,
) {
    val startedAtMs = System.currentTimeMillis()
    private val chunks = mutableListOf<ShortArray>()
    private var progress = UtteranceProgress()
    var end = UtteranceEnd.NONE
        private set
    /** Null until the first chunk after the wake phrase's tail. */
    var hearing: WakeHearing? = null
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
        hearing = WakeHearing(peakLevel(chunk), progress.speechMs > 0, progress.sendsInMs(policy))
        return end != UtteranceEnd.NONE
    }

    fun pcm(): ShortArray {
        val all = ShortArray(chunks.sumOf { it.size })
        var offset = 0
        chunks.forEach { it.copyInto(all, offset); offset += it.size }
        return all
    }
}

/** The same 0..1 meter scale as holding HOLD TO TALK, from the chunk's loudest sample. */
private fun peakLevel(chunk: ShortArray): Float =
    normalizeAmplitude(chunk.maxOf { kotlin.math.abs(it.toInt()) }.coerceAtMost(32_767))
