package io.agentmux.audioinbox

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import io.agentmux.wakeword.WAKE_CHUNK_MS
import io.agentmux.wakeword.WAKE_CHUNK_SAMPLES
import io.agentmux.wakeword.WAKE_SAMPLE_RATE
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** 16 kHz mono PCM in whole 80 ms chunks; the microphone in production, a local WAV fixture in QA. */
internal interface WakePcmSource : AutoCloseable {
    /** Fills [chunk] completely; false once the source has stopped delivering audio. */
    fun read(chunk: ShortArray): Boolean
}

/** Why a PCM source could not open, shown to the user instead of a silent wake word. */
internal class WakeSourceUnavailable(message: String) : Exception(message)

internal class MicrophonePcmSource private constructor(private val record: AudioRecord) : WakePcmSource {
    override fun read(chunk: ShortArray): Boolean {
        var filled = 0
        while (filled < chunk.size) {
            val count = record.read(chunk, filled, chunk.size - filled)
            if (count <= 0) return false
            filled += count
        }
        return true
    }

    override fun close() {
        runCatching { record.stop() }
        record.release()
    }

    companion object {
        @SuppressLint("MissingPermission")
        fun open(context: Context): MicrophonePcmSource {
            if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                throw WakeSourceUnavailable("Microphone permission is off")
            }
            val minimum = AudioRecord.getMinBufferSize(
                WAKE_SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
            )
            val record = AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                WAKE_SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                maxOf(minimum, WAKE_CHUNK_SAMPLES * 2 * 4),
            )
            if (record.state != AudioRecord.STATE_INITIALIZED) {
                record.release()
                throw WakeSourceUnavailable("Microphone is busy (another app or a call holds it)")
            }
            record.startRecording()
            if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                record.release()
                throw WakeSourceUnavailable("Microphone is busy (another app or a call holds it)")
            }
            return MicrophonePcmSource(record)
        }
    }
}

/** Debug QA only: plays a local 16 kHz mono WAV in real time, then silence, so the whole loop runs without a person speaking. */
internal class WavFixturePcmSource(file: File) : WakePcmSource {
    private val samples: ShortArray = ByteBuffer.wrap(file.readBytes(), 44, file.length().toInt() - 44)
        .order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().let { buffer -> ShortArray(buffer.remaining()).also(buffer::get) }
    private var position = 0

    override fun read(chunk: ShortArray): Boolean {
        Thread.sleep(WAKE_CHUNK_MS.toLong())
        chunk.fill(0)
        val count = minOf(chunk.size, samples.size - position).coerceAtLeast(0)
        samples.copyInto(chunk, 0, position, position + count)
        position += count
        return true
    }

    override fun close() = Unit
}
