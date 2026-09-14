package io.agentmux.wakeword

import java.io.File

internal fun modelBytes(name: String): ByteArray = File("models/$name").readBytes()

internal fun wakeModels(phrase: WakePhrase) = WakeWordModels(
    melspectrogram = OnnxFloatModel.load(modelBytes("melspectrogram.onnx")),
    embedding = OnnxFloatModel.load(modelBytes("embedding_model.onnx")),
    classifier = OnnxFloatModel.load(modelBytes(phrase.modelAsset)),
)

/** 16 kHz mono 16-bit WAV fixture split into whole 80 ms chunks, followed by one second of silence. */
internal fun wavChunks(resource: String): List<ShortArray> {
    val bytes = requireNotNull(WakeFixtures::class.java.getResourceAsStream("/$resource")).readBytes()
    val samples = readPcm16Wav(bytes) + ShortArray(WAKE_SAMPLE_RATE)
    return samples.toList().chunked(WAKE_CHUNK_SAMPLES).filter { it.size == WAKE_CHUNK_SAMPLES }.map { it.toShortArray() }
}

private object WakeFixtures
