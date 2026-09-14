package io.agentmux.wakeword

/** When a spoken question after the wake word counts as finished. */
data class EndpointPolicy(
    val speechProbability: Float = 0.5f,
    val waitForSpeechMs: Int = 5_000,
    val trailingSilenceMs: Int = 1_200,
    val maxUtteranceMs: Int = 30_000,
)

/** Why capture of a spoken question stopped; NONE keeps capturing. */
enum class UtteranceEnd {
    NONE,
    COMPLETE,
    NO_SPEECH,
    MAX_LENGTH,
}

/**
 * WHAT: Time counters for one question, advanced once per 80 ms VAD probability.
 * WHY: There is no release gesture after a wake word; silence and a hard cap end the capture.
 */
data class UtteranceProgress(
    val elapsedMs: Int = 0,
    val speechMs: Int = 0,
    val silenceAfterSpeechMs: Int = 0,
) {
    fun advance(probability: Float, policy: EndpointPolicy, chunkMs: Int = WAKE_CHUNK_MS): UtteranceProgress =
        if (probability >= policy.speechProbability) {
            copy(elapsedMs = elapsedMs + chunkMs, speechMs = speechMs + chunkMs, silenceAfterSpeechMs = 0)
        } else {
            copy(
                elapsedMs = elapsedMs + chunkMs,
                silenceAfterSpeechMs = if (speechMs > 0) silenceAfterSpeechMs + chunkMs else 0,
            )
        }

    fun end(policy: EndpointPolicy): UtteranceEnd = when {
        speechMs == 0 && elapsedMs >= policy.waitForSpeechMs -> UtteranceEnd.NO_SPEECH
        speechMs > 0 && silenceAfterSpeechMs >= policy.trailingSilenceMs -> UtteranceEnd.COMPLETE
        elapsedMs >= policy.maxUtteranceMs -> UtteranceEnd.MAX_LENGTH
        else -> UtteranceEnd.NONE
    }
}
