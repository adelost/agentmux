package io.agentmux.audioinbox

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.media.MediaRecorder
import java.io.File
import java.util.UUID

internal class PushToTalkRecorder(
    private val activity: Activity,
) {
    companion object {
        const val MICROPHONE_PERMISSION_REQUEST = 702
    }
    data class Capture(
        val turnId: String,
        val file: File,
        val startedAtMs: Long,
    )

    private var recorder: MediaRecorder? = null
    private var capture: Capture? = null

    fun begin(): Capture? {
        if (recorder != null) return null
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            activity.requestPermissions(
                arrayOf(Manifest.permission.RECORD_AUDIO),
                MICROPHONE_PERMISSION_REQUEST,
            )
            return null
        }
        val turnId = UUID.randomUUID().toString()
        val next = Capture(
            turnId,
            File(activity.cacheDir, "ptt-$turnId.m4a"),
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
        val active = recorder ?: return null
        val valid = runCatching {
            active.stop()
            active.release()
            recorder = null
            current.file.length() > 0
        }.getOrDefault(false)
        capture = null
        if (!valid) {
            current.file.delete()
            return null
        }
        return current
    }

    fun currentBytes(): Long = capture?.file?.length() ?: 0

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
