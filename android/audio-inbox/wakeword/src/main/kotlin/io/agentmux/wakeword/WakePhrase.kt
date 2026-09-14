package io.agentmux.wakeword

/** One wake phrase: what the user says, the classifier model file and its detection threshold. */
data class WakePhrase(val spoken: String, val modelAsset: String, val threshold: Float)

/** Phrases whose models ship in `wakeword/models`, with thresholds chosen from measurements in the README. */
object WakePhrases {
    val HEY_JARVIS = WakePhrase(spoken = "Hey Jarvis", modelAsset = "hey_jarvis_v0.1.onnx", threshold = 0.4f)
}
