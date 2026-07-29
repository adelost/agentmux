package io.agentmux.audioinbox.wear

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

internal enum class TtsEngineState {
    INITIALIZING,
    READY,
    FAILED,
}

internal enum class TtsRequestDecision {
    QUEUE,
    SPEAK,
    FAIL,
}

internal fun ttsRequestDecision(state: TtsEngineState): TtsRequestDecision = when (state) {
    TtsEngineState.INITIALIZING -> TtsRequestDecision.QUEUE
    TtsEngineState.READY -> TtsRequestDecision.SPEAK
    TtsEngineState.FAILED -> TtsRequestDecision.FAIL
}

internal class WearTtsPlayer(
    context: Context,
    private val listener: Listener,
) : AutoCloseable {
    interface Listener {
        fun onStarted(turnId: String)
        fun onCompleted(turnId: String)
        fun onFailed(turnId: String, detail: String)
    }

    private var state = TtsEngineState.INITIALIZING
    private var pending: Pair<String, String>? = null
    private lateinit var engine: TextToSpeech

    init {
        engine = TextToSpeech(context.applicationContext) { status ->
            state = if (status == TextToSpeech.SUCCESS) {
                TtsEngineState.READY
            } else {
                TtsEngineState.FAILED
            }
            if (state == TtsEngineState.FAILED) {
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
        when (ttsRequestDecision(state)) {
            TtsRequestDecision.QUEUE -> pending = turnId to text
            TtsRequestDecision.SPEAK -> speakNow(turnId, text)
            TtsRequestDecision.FAIL -> listener.onFailed(turnId, "TTS unavailable")
        }
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
