package io.agentmux.wakeword

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.FloatBuffer

private const val VAD_FRAME_SAMPLES = 640
private const val STATE_SIZE = 2 * 64

/**
 * WHAT: Silero VAD (v4 ONNX, recurrent h/c state) probability that an 80 ms chunk holds speech.
 * WHY: Ends a spoken question on silence in cars and hangars, where a loudness threshold fails.
 */
class SileroSpeechProbability private constructor(
    private val environment: OrtEnvironment,
    private val session: OrtSession,
) : AutoCloseable {
    private var hidden = FloatArray(STATE_SIZE)
    private var cell = FloatArray(STATE_SIZE)

    fun reset() {
        hidden = FloatArray(STATE_SIZE)
        cell = FloatArray(STATE_SIZE)
    }

    /** Mean speech probability of the chunk, split in 40 ms frames like openWakeWord's VAD. */
    fun probability(chunk: ShortArray): Float {
        require(chunk.size % VAD_FRAME_SAMPLES == 0) { "chunk must be a multiple of $VAD_FRAME_SAMPLES samples" }
        val frames = chunk.size / VAD_FRAME_SAMPLES
        return (0 until frames).map { frame ->
            frameProbability(FloatArray(VAD_FRAME_SAMPLES) { chunk[frame * VAD_FRAME_SAMPLES + it] / 32_767f })
        }.average().toFloat()
    }

    private fun frameProbability(samples: FloatArray): Float {
        val stateShape = longArrayOf(2, 1, 64)
        OnnxTensor.createTensor(environment, FloatBuffer.wrap(samples), longArrayOf(1, samples.size.toLong())).use { input ->
            OnnxTensor.createTensor(environment, WAKE_SAMPLE_RATE.toLong()).use { rate ->
                OnnxTensor.createTensor(environment, FloatBuffer.wrap(hidden), stateShape).use { h ->
                    OnnxTensor.createTensor(environment, FloatBuffer.wrap(cell), stateShape).use { c ->
                        session.run(mapOf("input" to input, "sr" to rate, "h" to h, "c" to c)).use { result ->
                            hidden = (result.get("hn").get() as OnnxTensor).floatBuffer.toArray()
                            cell = (result.get("cn").get() as OnnxTensor).floatBuffer.toArray()
                            return (result.get("output").get() as OnnxTensor).floatBuffer.get(0)
                        }
                    }
                }
            }
        }
    }

    override fun close() = session.close()

    companion object {
        fun load(bytes: ByteArray): SileroSpeechProbability {
            val environment = OrtEnvironment.getEnvironment()
            return SileroSpeechProbability(environment, environment.createSession(bytes, singleThreadOptions()))
        }
    }
}

private fun FloatBuffer.toArray(): FloatArray = FloatArray(remaining()).also(::get)
