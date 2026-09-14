package io.agentmux.wakeword

/** One wake phrase: its stable id, what the user says, the classifier model file and its detection threshold. */
data class WakePhrase(val id: String, val spoken: String, val modelAsset: String, val threshold: Float)

/** Phrases whose models ship in `wakeword/models`, with thresholds chosen from measurements in the README. */
object WakePhrases {
    val HEY_JARVIS = WakePhrase(id = "hey-jarvis", spoken = "Hey Jarvis", modelAsset = "hey_jarvis_v0.1.onnx", threshold = 0.4f)
    val HEY_MARVIN = WakePhrase(id = "hey-marvin", spoken = "Hey Marvin", modelAsset = "hey_marvin_v0.1.onnx", threshold = 0.5f)
    val ALEXA = WakePhrase(id = "alexa", spoken = "Alexa", modelAsset = "alexa_v0.1.onnx", threshold = 0.5f)

    /** The choice a user gets, default first. Hey Mycroft ships with openWakeWord too but woke on 0 of 12 Swedish voices. */
    val offered = listOf(HEY_JARVIS, HEY_MARVIN, ALEXA)

    /** A stored choice; null for an id this build does not offer, so the caller decides what an unknown value means. */
    fun byId(id: String?): WakePhrase? = offered.firstOrNull { it.id == id }
}
