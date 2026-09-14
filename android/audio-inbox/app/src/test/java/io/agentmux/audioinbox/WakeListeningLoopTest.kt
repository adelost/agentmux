package io.agentmux.audioinbox

import io.agentmux.wakeword.EndpointPolicy
import io.agentmux.wakeword.UtteranceEnd
import io.agentmux.wakeword.WakeHearing
import org.junit.Assert.assertEquals
import org.junit.Test

// Mattias 2026-09-15: after a reply the phone must not start recording on its own; only the wake phrase starts a
// question, and a question can be cancelled before it is sent.
class WakeListeningLoopTest {
    /** Chunks scripted as (wake score, speech probability); the source stops after the script. */
    private class Script(val chunks: List<Pair<Float, Float>>) : WakePcmSource {
        var index = -1
        var onChunk: (Int) -> Unit = {}
        override fun read(chunk: ShortArray): Boolean {
            index += 1
            if (index >= chunks.size) return false
            onChunk(index)
            return true
        }
        override fun close() = Unit
    }

    private class Heard : WakeLoopListener {
        val questions = mutableListOf<UtteranceEnd>()
        var detections = 0
        override fun onDetected(score: Float) { detections += 1 }
        override fun onHearing(hearing: WakeHearing) = Unit
        override fun onQuestion(end: UtteranceEnd, pcm: ShortArray, startedAtMs: Long) { questions += end }
        override fun onSourceStopped() = Unit
    }

    private fun loop(script: Script, heard: Heard): WakeListeningLoop = WakeListeningLoop(
        source = script,
        detector = object : WakeChunkScorer {
            override fun score(chunk: ShortArray) = script.chunks[script.index].first
            override fun reset() = Unit
        },
        vad = object : SpeechChunkProbability {
            override fun probability(chunk: ShortArray) = script.chunks[script.index].second
            override fun reset() = Unit
        },
        threshold = 0.5f,
        policy = EndpointPolicy(),
        detectionAllowed = { true },
        listener = heard,
    )

    private fun speech(chunks: Int) = List(chunks) { 0f to 0.95f }
    private fun silence(chunks: Int) = List(chunks) { 0f to 0.01f }

    @Test
    fun speechWithoutTheWakePhraseNeverBecomesAQuestion() {
        val heard = Heard()
        loop(Script(speech(60) + silence(80) + speech(60) + silence(80)), heard).run()
        assertEquals(0 to emptyList<UtteranceEnd>(), heard.detections to heard.questions)
    }

    @Test
    fun theWakePhraseStartsExactlyOneQuestion() {
        val heard = Heard()
        loop(Script(listOf(0.9f to 0f) + speech(20) + silence(80) + speech(60) + silence(80)), heard).run()
        assertEquals(1 to listOf(UtteranceEnd.COMPLETE), heard.detections to heard.questions)
    }

    @Test
    fun aCancelledQuestionIsDroppedAndNeverDelivered() {
        val heard = Heard()
        val script = Script(listOf(0.9f to 0f) + speech(20) + silence(80))
        val loop = loop(script, heard)
        script.onChunk = { index -> if (index == 10) loop.cancelQuestion() }
        loop.run()
        assertEquals(1 to emptyList<UtteranceEnd>(), heard.detections to heard.questions)
    }
}
