package io.agentmux.linkui

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import java.util.concurrent.Executors
import kotlin.math.PI
import kotlin.math.sin

/** WHAT: Carries one listening-cue tone. WHY: Keeps pitch and duration explicit in the shared pattern. */
data class LinkListeningCueNote(val frequencyHz: Int, val durationMs: Int)

/** WHAT: Builds Link's short two-note listening rise. WHY: Keeps the audible identity testable outside Android volume routing. */
object LinkListeningCuePattern {
    const val sampleRate = 16_000
    const val amplitude = 0.08f
    private const val gapMs = 10
    private const val edgeMs = 7
    val notes = listOf(LinkListeningCueNote(660, 55), LinkListeningCueNote(880, 65))
    val durationMs = notes.sumOf(LinkListeningCueNote::durationMs) + gapMs

    fun pcm(): ShortArray = ShortArray(sampleRate * durationMs / 1_000) { sample ->
        val atMs = sample * 1_000 / sampleRate
        when {
            atMs < notes[0].durationMs -> note(notes[0], sample)
            atMs < notes[0].durationMs + gapMs -> 0
            else -> note(notes[1], sample - sampleRate * (notes[0].durationMs + gapMs) / 1_000)
        }
    }

    private fun note(note: LinkListeningCueNote, localSample: Int): Short {
        val noteSamples = sampleRate * note.durationMs / 1_000
        val edgeSamples = sampleRate * edgeMs / 1_000
        val edge = minOf(localSample, noteSamples - 1 - localSample, edgeSamples).coerceAtLeast(0)
        val envelope = edge.toFloat() / edgeSamples.coerceAtLeast(1)
        val wave = sin(2.0 * PI * note.frequencyHz * localSample / sampleRate)
        return (wave * envelope * amplitude * Short.MAX_VALUE).toInt().toShort()
    }
}

/** WHAT: Routes listening feedback by preference. WHY: Keeps sound-off independent from the haptic receipt. */
class LinkListeningCue(
    private val soundEnabled: () -> Boolean,
    private val playSound: () -> Unit,
    private val playHaptic: () -> Unit,
) {
    fun listeningStarted() {
        playHaptic()
        if (soundEnabled()) playSound()
    }
}

/** WHAT: Builds Android sonification and vibration. WHY: Keeps media mute from hiding microphone activation. */
class AndroidLinkListeningCue(
    context: Context,
    soundEnabled: () -> Boolean,
) : AutoCloseable {
    private val application = context.applicationContext
    private val sound = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "link-listening-cue").apply { isDaemon = true }
    }
    private val cue = LinkListeningCue(
        soundEnabled = soundEnabled,
        playSound = { sound.execute(::playRise) },
        playHaptic = ::playHaptic,
    )

    fun listeningStarted() = cue.listeningStarted()

    private fun playRise() {
        val pcm = LinkListeningCuePattern.pcm()
        val track = runCatching {
            AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(audioUsage)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(LinkListeningCuePattern.sampleRate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build(),
                )
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(pcm.size * Short.SIZE_BYTES)
                .build()
        }.getOrNull() ?: return
        try {
            if (track.write(pcm, 0, pcm.size) != pcm.size) return
            track.play()
            Thread.sleep(LinkListeningCuePattern.durationMs.toLong() + 30L)
        } finally {
            runCatching { track.stop() }
            track.release()
        }
    }

    private fun playHaptic() {
        val vibrator = if (Build.VERSION.SDK_INT >= 31) {
            application.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            application.getSystemService(Vibrator::class.java)
        }
        if (vibrator?.hasVibrator() == true) {
            vibrator.vibrate(VibrationEffect.createOneShot(28L, 72))
        }
    }

    override fun close() {
        sound.shutdownNow()
    }

    companion object {
        const val audioUsage = AudioAttributes.USAGE_ASSISTANCE_SONIFICATION
    }
}
