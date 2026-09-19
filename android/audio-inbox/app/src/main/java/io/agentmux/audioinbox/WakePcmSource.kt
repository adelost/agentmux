package io.agentmux.audioinbox

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import io.agentmux.wakeword.WAKE_CHUNK_MS
import io.agentmux.wakeword.WAKE_CHUNK_SAMPLES
import io.agentmux.wakeword.WAKE_SAMPLE_RATE
import java.io.File
import io.agentmux.wakeword.WakePcmSource
import io.agentmux.wakeword.WakePhase
import io.agentmux.wakeword.readPcm16Wav

/** Why a PCM source could not open, shown to the user instead of a silent wake word. */
internal class WakeSourceUnavailable(message: String) : Exception(message)

internal class MicrophonePcmSource private constructor(
    private val record: AudioRecord,
    private val echoCanceler: AcousticEchoCanceler?,
) : WakePcmSource {
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
        echoCanceler?.release()
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
            // Removes the phone's own reply from the microphone so the phrase can interrupt it.
            val echoCanceler = if (AcousticEchoCanceler.isAvailable()) {
                AcousticEchoCanceler.create(record.audioSessionId)?.apply { enabled = true }
            } else {
                null
            }
            return MicrophonePcmSource(record, echoCanceler)
        }
    }
}

/**
 * Debug QA only: plays local 16 kHz mono WAV clips in real time with silence between them.
 * A spec is `clip.wav` or `PHASE@clip.wav|PHASE@clip.wav`; each clip waits until the loop reaches
 * that phase, so a question after a reply or an interruption lands at the right moment however slow the server is.
 */
internal class WavFixturePcmSource(spec: String, private val phase: () -> WakePhase) : WakePcmSource {
    private val steps = spec.split("|").map { step ->
        val at = step.indexOf('@')
        val waitFor = if (at > 0) WakePhase.valueOf(step.substring(0, at)) else null
        waitFor to readPcm16Wav(File(step.substring(at + 1)).readBytes())
    }
    private var step = 0
    private var position = 0

    override fun read(chunk: ShortArray): Boolean {
        Thread.sleep(WAKE_CHUNK_MS.toLong())
        chunk.fill(0)
        val (waitFor, samples) = steps.getOrNull(step) ?: return true
        if (position == 0 && waitFor != null && phase() != waitFor) return true
        val count = minOf(chunk.size, samples.size - position)
        samples.copyInto(chunk, 0, position, position + count)
        position += count
        if (position >= samples.size) {
            step += 1
            position = 0
        }
        return true
    }

    override fun close() = Unit
}
