package io.agentmux.wakeword

/** openWakeWord consumes 16 kHz mono PCM in 80 ms frames. */
const val WAKE_SAMPLE_RATE = 16_000
const val WAKE_CHUNK_SAMPLES = 1_280
const val WAKE_CHUNK_MS = 80

private const val MEL_CONTEXT_SAMPLES = 160 * 3
private const val MEL_BINS = 32
private const val EMBEDDING_WINDOW = 76
private const val EMBEDDING_SIZE = 96
private const val WARMUP_CHUNKS = 5

/** The three models of one openWakeWord phrase: shared features plus the phrase classifier. */
class WakeWordModels(
    val melspectrogram: OnnxFloatModel,
    val embedding: OnnxFloatModel,
    val classifier: OnnxFloatModel,
) : AutoCloseable {
    override fun close() {
        classifier.close()
        embedding.close()
        melspectrogram.close()
    }
}

/**
 * WHAT: Streams PCM through melspectrogram, speech embedding and classifier, one score per 80 ms.
 * WHY: Mirrors openWakeWord's Python streaming path so published phrase models keep their accuracy.
 */
class WakeWordDetector(private val models: WakeWordModels) {
    private val featureFrames = models.classifier.inputDimension(1).toInt()
    private val audio = FloatArray(WAKE_CHUNK_SAMPLES + MEL_CONTEXT_SAMPLES)
    private val melFrames = ArrayDeque<FloatArray>()
    private val embeddings = ArrayDeque<FloatArray>()
    private var chunks = 0

    init {
        reset()
    }

    /** Forget all audio, as after a finished conversation turn. */
    fun reset() {
        audio.fill(0f)
        melFrames.clear()
        repeat(EMBEDDING_WINDOW) { melFrames.addLast(FloatArray(MEL_BINS) { 1f }) }
        val silence = silentEmbedding()
        embeddings.clear()
        repeat(featureFrames) { embeddings.addLast(silence) }
        chunks = 0
    }

    /** Score one 80 ms chunk; the first chunks after a reset score zero while buffers fill. */
    fun score(chunk: ShortArray): Float {
        require(chunk.size == WAKE_CHUNK_SAMPLES) { "expected $WAKE_CHUNK_SAMPLES samples, got ${chunk.size}" }
        appendAudio(chunk)
        melspectrogram(audio).forEach(::appendMelFrame)
        appendEmbedding(embed(melWindow()))
        chunks += 1
        val score = classify()
        return if (chunks <= WARMUP_CHUNKS) 0f else score
    }

    private fun appendAudio(chunk: ShortArray) {
        System.arraycopy(audio, WAKE_CHUNK_SAMPLES, audio, 0, MEL_CONTEXT_SAMPLES)
        chunk.forEachIndexed { index, sample -> audio[MEL_CONTEXT_SAMPLES + index] = sample.toFloat() }
    }

    private fun melspectrogram(samples: FloatArray): List<FloatArray> {
        val flat = models.melspectrogram.run(samples, longArrayOf(1, samples.size.toLong()))
        return (0 until flat.size / MEL_BINS).map { frame ->
            FloatArray(MEL_BINS) { bin -> flat[frame * MEL_BINS + bin] / 10f + 2f }
        }
    }

    private fun appendMelFrame(frame: FloatArray) {
        melFrames.addLast(frame)
        while (melFrames.size > EMBEDDING_WINDOW) melFrames.removeFirst()
    }

    private fun melWindow(): FloatArray {
        val window = FloatArray(EMBEDDING_WINDOW * MEL_BINS)
        melFrames.forEachIndexed { row, frame -> frame.copyInto(window, row * MEL_BINS) }
        return window
    }

    private fun embed(window: FloatArray): FloatArray =
        models.embedding.run(window, longArrayOf(1, EMBEDDING_WINDOW.toLong(), MEL_BINS.toLong(), 1))

    private fun appendEmbedding(embedding: FloatArray) {
        embeddings.addLast(embedding)
        while (embeddings.size > featureFrames) embeddings.removeFirst()
    }

    private fun classify(): Float {
        val features = FloatArray(featureFrames * EMBEDDING_SIZE)
        embeddings.forEachIndexed { row, embedding -> embedding.copyInto(features, row * EMBEDDING_SIZE) }
        return models.classifier.run(features, longArrayOf(1, featureFrames.toLong(), EMBEDDING_SIZE.toLong()))[0]
    }

    /** openWakeWord seeds its feature history with embeddings of silence, not zeros. */
    private fun silentEmbedding(): FloatArray {
        val frames = melspectrogram(FloatArray(WAKE_SAMPLE_RATE * 2))
        val window = FloatArray(EMBEDDING_WINDOW * MEL_BINS)
        frames.subList(frames.size / 2 - EMBEDDING_WINDOW / 2, frames.size / 2 + EMBEDDING_WINDOW / 2)
            .forEachIndexed { row, frame -> frame.copyInto(window, row * MEL_BINS) }
        return embed(window)
    }
}
