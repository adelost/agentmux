package io.agentmux.audioinbox.wear

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

internal class WearTtsPlayer(
    context: Context,
    private val listener: Listener,
) : AutoCloseable {
    interface Listener {
        fun onStarted(turnId: String)
        fun onCompleted(turnId: String)
        fun onFailed(turnId: String, detail: String)
    }

    private var ready = false
    private var pending: Pair<String, String>? = null
    private lateinit var engine: TextToSpeech

    init {
        engine = TextToSpeech(context.applicationContext) { status ->
            ready = status == TextToSpeech.SUCCESS
            if (!ready) {
                pending?.first?.let { listener.onFailed(it, "TTS unavailable") }
                pending = null
            } else {
                engine.language = Locale.getDefault()
                pending?.let { (turnId, text) -> speakNow(turnId, text) }
                pending = null
            }
        }
        engine.apply {
            setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String) = listener.onStarted(utteranceId)
                override fun onDone(utteranceId: String) = listener.onCompleted(utteranceId)

                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String) =
                    listener.onFailed(utteranceId, "TTS playback failed")

                override fun onError(utteranceId: String, errorCode: Int) =
                    listener.onFailed(utteranceId, "TTS playback failed · $errorCode")
            })
        }
    }

    fun play(turnId: String, text: String) {
        if (text.isBlank()) return
        if (!ready) {
            pending = turnId to text
            return
        }
        speakNow(turnId, text)
    }

    fun stop() {
        pending = null
        engine.stop()
    }

    private fun speakNow(turnId: String, text: String) {
        val result = engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, turnId)
        if (result == TextToSpeech.ERROR) listener.onFailed(turnId, "TTS start failed")
    }

    override fun close() {
        stop()
        engine.shutdown()
    }
}
