package io.agentmux.audioinbox

import android.media.AudioManager
import android.media.ToneGenerator

/** Short tones for each hands-free step, so the phone can stay in a pocket. */
internal class WakeEarcons : AutoCloseable {
    private val tones = ToneGenerator(AudioManager.STREAM_MUSIC, 80)
    private val quiet = ToneGenerator(AudioManager.STREAM_MUSIC, 35)

    fun sent() = tones.startTone(ToneGenerator.TONE_PROP_ACK, 150)
    fun thinking() = quiet.startTone(ToneGenerator.TONE_PROP_BEEP, 60)
    fun failed() = tones.startTone(ToneGenerator.TONE_PROP_NACK, 200)

    override fun close() {
        tones.release()
        quiet.release()
    }
}
