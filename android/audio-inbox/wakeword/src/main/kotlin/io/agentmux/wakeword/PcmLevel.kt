package io.agentmux.wakeword

import kotlin.math.sqrt

/** A 0..1 voice meter from a 16-bit peak amplitude, shared by the held control and the hands-free loop. */
fun normalizeAmplitude(amplitude: Int): Float {
    require(amplitude >= 0)
    return sqrt((amplitude / 32_767f).coerceIn(0f, 1f))
}
