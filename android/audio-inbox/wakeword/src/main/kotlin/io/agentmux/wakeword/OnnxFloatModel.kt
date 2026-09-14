package io.agentmux.wakeword

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import java.nio.FloatBuffer

/**
 * WHAT: Runs a single-input, single-output float ONNX model on one thread.
 * WHY: The wake pipeline chains three such models; one wrapper keeps tensor lifetimes closed.
 */
class OnnxFloatModel private constructor(
    private val environment: OrtEnvironment,
    private val session: OrtSession,
) : AutoCloseable {
    private val inputName: String = session.inputNames.first()

    /** The declared size of one input dimension, or -1 when the model leaves it dynamic. */
    fun inputDimension(index: Int): Long =
        (session.inputInfo.getValue(inputName).info as TensorInfo).shape[index]

    fun run(values: FloatArray, shape: LongArray): FloatArray =
        OnnxTensor.createTensor(environment, FloatBuffer.wrap(values), shape).use { input ->
            session.run(mapOf(inputName to input)).use { result ->
                val output = (result.get(0) as OnnxTensor).floatBuffer
                FloatArray(output.remaining()).also(output::get)
            }
        }

    override fun close() = session.close()

    companion object {
        fun load(bytes: ByteArray): OnnxFloatModel {
            val environment = OrtEnvironment.getEnvironment()
            return OnnxFloatModel(environment, environment.createSession(bytes, singleThreadOptions()))
        }
    }
}

internal fun singleThreadOptions(): OrtSession.SessionOptions =
    OrtSession.SessionOptions().apply {
        setIntraOpNumThreads(1)
        setInterOpNumThreads(1)
    }
