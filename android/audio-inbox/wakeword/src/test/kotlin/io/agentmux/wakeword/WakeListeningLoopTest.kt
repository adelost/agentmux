package io.agentmux.wakeword

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

    /** Every chunk the loop handed to a watcher, as (millisecond, score, speech probability). */
    private class Watched : WakeChunkTrace {
        val rows = mutableListOf<Triple<Long, Float, Float>>()
        override fun onChunkScored(atMs: Long, score: Float, speechProbability: Float) {
            rows += Triple(atMs, score, speechProbability)
        }
    }

    private class CountedSpeech(private val script: Script) : SpeechChunkProbability {
        var asked = 0
            private set
        override fun probability(chunk: ShortArray): Float {
            asked += 1
            return script.chunks[script.index].second
        }
        override fun reset() = Unit
    }

    private fun loop(
        script: Script,
        heard: Heard,
        vad: SpeechChunkProbability = CountedSpeech(script),
        trace: WakeChunkTrace? = null,
    ): WakeListeningLoop = WakeListeningLoop(
        source = script,
        detector = object : WakeChunkScorer {
            override fun score(chunk: ShortArray) = script.chunks[script.index].first
            override fun reset() = Unit
        },
        vad = vad,
        threshold = 0.5f,
        policy = EndpointPolicy(),
        detectionAllowed = { true },
        listener = heard,
        trace = trace,
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

    // A wake word that fires too often cannot be tuned from the wakes alone, so a watcher may read every
    // waiting chunk. Nobody pays for that until someone is watching: the second model is not asked at all.
    @Test
    fun nobodyWatchingMeansTheSpeechModelIsNeverAskedWhileWaiting() {
        val script = Script(speech(40))
        val vad = CountedSpeech(script)
        loop(script, Heard(), vad = vad).run()
        assertEquals(0, vad.asked)
    }

    @Test
    fun aWatcherReadsEveryWaitingChunkAndNothingOfTheQuestion() {
        val script = Script(silence(3) + listOf(0.9f to 0f) + speech(20) + silence(80))
        val watched = Watched()
        val heard = Heard()
        loop(script, heard, trace = watched).run()
        assertEquals(1 to listOf(UtteranceEnd.COMPLETE), heard.detections to heard.questions)
        // The three quiet chunks and the one that fired, both models' readings on each.
        assertEquals(listOf(80L, 160L, 240L, 320L), watched.rows.take(4).map { it.first })
        assertEquals(0.9f to 0f, watched.rows[3].let { it.second to it.third })
        // Then nothing until the question is over: a capture is not waiting, and the trace is about waiting.
        val afterTheQuestion = watched.rows[4].first
        assertEquals(true, afterTheQuestion - 320L >= EndpointPolicy().trailingSilenceMs)
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
