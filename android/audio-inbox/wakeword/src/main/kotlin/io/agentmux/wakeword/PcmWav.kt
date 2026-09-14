package io.agentmux.wakeword

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * WHAT: Reads the samples of a 16 kHz mono 16-bit PCM WAV, skipping any metadata chunks.
 * WHY: Recorded and synthesized fixtures carry LIST chunks; a fixed 44-byte header would read them as audio.
 */
fun readPcm16Wav(bytes: ByteArray): ShortArray {
    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    require(bytes.size >= 12 && String(bytes, 0, 4) == "RIFF" && String(bytes, 8, 4) == "WAVE") { "not a WAV file" }
    var offset = 12
    while (offset + 8 <= bytes.size) {
        val id = String(bytes, offset, 4)
        val size = buffer.getInt(offset + 4)
        if (id == "fmt ") {
            require(buffer.getShort(offset + 8).toInt() == 1 && buffer.getShort(offset + 10).toInt() == 1 &&
                buffer.getInt(offset + 12) == WAKE_SAMPLE_RATE && buffer.getShort(offset + 22).toInt() == 16) {
                "WAV must be 16 kHz mono 16-bit PCM"
            }
        }
        if (id == "data") {
            val samples = ByteBuffer.wrap(bytes, offset + 8, minOf(size, bytes.size - offset - 8))
                .order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
            return ShortArray(samples.remaining()).also(samples::get)
        }
        offset += 8 + size + size % 2
    }
    error("WAV has no data chunk")
}
