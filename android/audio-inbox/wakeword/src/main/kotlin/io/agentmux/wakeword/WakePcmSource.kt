package io.agentmux.wakeword

/** 16 kHz mono PCM in whole 80 ms chunks: the microphone in production, a WAV file in a measurement or in QA. */
interface WakePcmSource : AutoCloseable {
    /** Fills [chunk] completely; false once the source has stopped delivering audio. */
    fun read(chunk: ShortArray): Boolean
}
