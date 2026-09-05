package io.agentmux.audioinbox.wear

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaRecorder
import io.agentmux.linkcore.RecorderFinalizer
import java.io.File
import java.util.UUID
import kotlin.math.sqrt

internal class WearVoiceRecorder(
    private val context: Context,
) {
    data class Capture(
        val turnId: String,
        val file: File,
        val startedAtMs: Long,
    )

    private var recorder: MediaRecorder? = null
    private var capture: Capture? = null

    fun begin(): Capture? {
        if (recorder != null ||
            context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return null
        }
        val turnId = UUID.randomUUID().toString()
        val next = Capture(
            turnId,
            File(context.cacheDir, "wear-ptt-$turnId.m4a"),
            System.currentTimeMillis(),
        )
        return runCatching {
            recorder = MediaRecorder().apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioChannels(1)
                setAudioSamplingRate(44_100)
                setAudioEncodingBitRate(96_000)
                setOutputFile(next.file.absolutePath)
                prepare()
                start()
            }
            capture = next
            next
        }.getOrElse {
            cancel()
            null
        }
    }

    fun release(): Capture? {
        val current = capture ?: return null
        val active = recorder
        recorder = null
        capture = null
        if (active == null) {
            current.file.delete()
            return null
        }
        val valid = RecorderFinalizer.finish(
            recorder = active,
            stop = MediaRecorder::stop,
            release = MediaRecorder::release,
            hasPayload = { current.file.length() > 0 },
        )
        if (!valid) {
            current.file.delete()
            return null
        }
        return current
    }

    fun currentBytes(): Long = capture?.file?.length() ?: 0

    fun currentLevel(): Float = runCatching {
        sqrt(((recorder?.maxAmplitude ?: 0) / 32_767f).coerceIn(0f, 1f))
    }.getOrDefault(0f)

    fun cancel() {
        recorder?.let {
            runCatching { it.reset() }
            runCatching { it.release() }
        }
        recorder = null
        capture?.file?.delete()
        capture = null
    }
}
