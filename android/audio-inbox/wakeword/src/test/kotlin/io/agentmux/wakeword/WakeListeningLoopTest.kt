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
        val runs = mutableListOf<WakeRun>()
        override fun onChunkScored(atMs: Long, score: Float, speechProbability: Float, chunksOverThreshold: Int) {
            rows += Triple(atMs, score, speechProbability)
        }
        override fun onRunEnded(run: WakeRun) { runs += run }
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
        detection: WakeDetectionPolicy = WakeDetectionPolicy(),
    ): WakeListeningLoop = WakeListeningLoop(
        source = script,
        detector = object : WakeChunkScorer {
            override fun score(chunk: ShortArray) = script.chunks[script.index].first
            override fun reset() = Unit
        },
        vad = vad,
        threshold = 0.5f,
        endpoint = EndpointPolicy(),
        detection = detection,
        detectionAllowed = { true },
        listener = heard,
        trace = trace,
    )

    /** The phrase as the shipped rule needs to hear it: two chunks in a row at or over the threshold. */
    private val saidTwice = listOf(0.9f to 0f, 0.9f to 0f)
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
        loop(Script(saidTwice + speech(20) + silence(80) + speech(60) + silence(80)), heard).run()
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
        val script = Script(silence(3) + saidTwice + speech(20) + silence(80))
        val watched = Watched()
        val heard = Heard()
        loop(script, heard, trace = watched).run()
        assertEquals(1 to listOf(UtteranceEnd.COMPLETE), heard.detections to heard.questions)
        // The three quiet chunks and both chunks of the phrase, with both models' readings on each.
        assertEquals(listOf(80L, 160L, 240L, 320L, 400L), watched.rows.take(5).map { it.first })
        assertEquals(0.9f to 0f, watched.rows[4].let { it.second to it.third })
        // Then nothing until the question is over: a capture is not waiting, and the trace is about waiting.
        val afterTheQuestion = watched.rows[5].first
        assertEquals(true, afterTheQuestion - 400L >= EndpointPolicy().trailingSilenceMs)
    }

    // Measured 2026-09-19: every false wake in 68 minutes was a lone chunk whose neighbour scored 0.07 to 0.22.
    // A rule of two asks the second model of that twelfth of a second to agree with the first.
    @Test
    fun aRuleOfTwoRefusesASingleChunkAndAcceptsTwoInARow() {
        val lone = Heard()
        loop(Script(listOf(0.9f to 0f) + silence(40)), lone, detection = WakeDetectionPolicy(2)).run()
        assertEquals(0, lone.detections)

        val twice = Heard()
        val script = Script(listOf(0.9f to 0f, 0.9f to 0f) + speech(20) + silence(80))
        loop(script, twice, detection = WakeDetectionPolicy(2)).run()
        assertEquals(1 to listOf(UtteranceEnd.COMPLETE), twice.detections to twice.questions)
    }

    @Test
    fun aChunkUnderTheThresholdBreaksTheRunRatherThanShorteningIt() {
        val heard = Heard()
        val nearMisses = listOf(0.9f to 0f, 0.1f to 0f, 0.9f to 0f, 0.1f to 0f, 0.9f to 0f)
        loop(Script(nearMisses + silence(40)), heard, detection = WakeDetectionPolicy(2)).run()
        assertEquals(0, heard.detections)
    }

    // lsrc:0 2026-09-19: the device pass exists to find a phrase someone said that the run rule refused,
    // so that case has to be distinct in the trace, not buried among the chunks.
    @Test
    fun aPhraseOverTheThresholdForOneChunkIsAnEventOfItsOwn() {
        val watched = Watched()
        loop(Script(listOf(0.72f to 0.9f) + silence(40)), Heard(), trace = watched).run()
        assertEquals(1, watched.runs.size)
        val refused = watched.runs.single()
        assertEquals(WakeRefusal.NOT_ENOUGH_CHUNKS, refused.refusal)
        assertEquals(1, refused.chunksOverThreshold)
        assertEquals(0.72f, refused.peakScore, 0.0001f)
        assertEquals(0.9f, refused.speechProbability, 0.0001f)
        assertEquals(false, refused.accepted)
    }

    @Test
    fun aRunThatBecomesAQuestionIsTheSameEventWithoutARefusal() {
        val watched = Watched()
        loop(Script(saidTwice + speech(20) + silence(80)), Heard(), trace = watched).run()
        val accepted = watched.runs.first()
        assertEquals(true, accepted.accepted)
        assertEquals(2, accepted.chunksOverThreshold)
        assertEquals(0.9f, accepted.peakScore, 0.0001f)
    }

    @Test
    fun theRunInProgressIsCountedOnTheChunkItselfAndClearedWhenItBreaks() {
        val counted = mutableListOf<Int>()
        val watched = object : WakeChunkTrace {
            override fun onChunkScored(atMs: Long, score: Float, speechProbability: Float, chunksOverThreshold: Int) {
                counted += chunksOverThreshold
            }
            override fun onRunEnded(run: WakeRun) = Unit
        }
        val script = Script(listOf(0.9f to 0f, 0.9f to 0f, 0.1f to 0f, 0.9f to 0f) + silence(10))
        loop(script, Heard(), trace = watched, detection = WakeDetectionPolicy(3)).run()
        assertEquals(listOf(1, 2, 0, 1), counted.take(4))
    }

    @Test
    fun aRuleOfZeroChunksIsRefusedByName() {
        val refusal = runCatching { WakeDetectionPolicy(0) }.exceptionOrNull()
        assertEquals(
            "a question needs at least one chunk at or over the threshold, not 0",
            refusal?.message,
        )
    }

    // The shipped rule, not a number typed twice: whatever WakeDetectionPolicy's default is, a lone chunk
    // must not start a question, because that is the shape every measured false wake had.
    @Test
    fun theShippedRuleRefusesALoneChunkOverTheThreshold() {
        val heard = Heard()
        loop(Script(listOf(0.9f to 0f) + silence(40)), heard).run()
        assertEquals(0, heard.detections)
    }

    @Test
    fun theDelayARuleAddsIsTheChunksItWaitsFor() {
        assertEquals(listOf(0, 80, 160), listOf(1, 2, 3).map { WakeDetectionPolicy(it).delayMs })
    }

    @Test
    fun aCancelledQuestionIsDroppedAndNeverDelivered() {
        val heard = Heard()
        val script = Script(saidTwice + speech(20) + silence(80))
        val loop = loop(script, heard)
        script.onChunk = { index -> if (index == 10) loop.cancelQuestion() }
        loop.run()
        assertEquals(1 to emptyList<UtteranceEnd>(), heard.detections to heard.questions)
    }
}
