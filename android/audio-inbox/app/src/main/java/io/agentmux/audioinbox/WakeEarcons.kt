package io.agentmux.audioinbox

import android.media.AudioManager
import android.media.ToneGenerator

/** Short tones for each hands-free step, so the phone can stay in a pocket. */
internal class WakeEarcons : AutoCloseable {
    private val tones = ToneGenerator(AudioManager.STREAM_MUSIC, 80)

    fun heard() = play(ToneGenerator.TONE_PROP_BEEP, 150)
    fun sent() = play(ToneGenerator.TONE_PROP_ACK, 150)
    fun thinking() = play(ToneGenerator.TONE_SUP_RINGTONE, 100)
    fun failed() = play(ToneGenerator.TONE_PROP_NACK, 200)

    private fun play(tone: Int, durationMs: Int) {
        tones.startTone(tone, durationMs)
    }

    override fun close() = tones.release()
}
