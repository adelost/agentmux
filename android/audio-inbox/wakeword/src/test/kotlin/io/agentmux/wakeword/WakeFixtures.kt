package io.agentmux.wakeword

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

internal fun modelBytes(name: String): ByteArray = File("models/$name").readBytes()

internal fun computerModels() = WakeWordModels(
    melspectrogram = OnnxFloatModel.load(modelBytes("melspectrogram.onnx")),
    embedding = OnnxFloatModel.load(modelBytes("embedding_model.onnx")),
    classifier = OnnxFloatModel.load(modelBytes("computer_v1.onnx")),
)

/** 16 kHz mono 16-bit WAV fixture split into whole 80 ms chunks, followed by one second of silence. */
internal fun wavChunks(resource: String): List<ShortArray> {
    val bytes = requireNotNull(WakeFixtures::class.java.getResourceAsStream("/$resource")).readBytes()
    val data = ByteBuffer.wrap(bytes, 44, bytes.size - 44).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
    val samples = ShortArray(data.remaining()).also(data::get) + ShortArray(WAKE_SAMPLE_RATE)
    return samples.toList().chunked(WAKE_CHUNK_SAMPLES).filter { it.size == WAKE_CHUNK_SAMPLES }.map { it.toShortArray() }
}

private object WakeFixtures
