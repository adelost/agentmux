package io.agentmux.wakeword

/** Where the hands-free loop is: waiting for the word, hearing a question, or handling its turn. */
enum class WakePhase {
    OFF,
    LISTENING,
    CAPTURING,
    SENDING,
    THINKING,
    SPEAKING,
    BLOCKED,
}

/** How far the host app has carried one submitted question; each app maps its own turn model here. */
enum class TurnStage {
    SENDING,
    SEND_FAILED,
    THINKING,
    REPLY_FAILED,
    SPEAKING,
    SPOKEN,
    SPEAK_FAILED,
    GONE,
}

data class TurnProgress(val stage: TurnStage, val error: String = "")

/** Everything the notification and settings row show about the hands-free loop. */
data class WakeStatus(
    val phase: WakePhase = WakePhase.OFF,
    val turnId: String? = null,
    val detail: String = "",
    val lastDetectionScore: Float = 0f,
    val detections: Int = 0,
)

sealed interface WakeEvent {
    data object Start : WakeEvent
    data object Stop : WakeEvent
    data class Blocked(val reason: String) : WakeEvent
    data class Detected(val score: Float) : WakeEvent
    data class CaptureEnded(val end: UtteranceEnd, val turnId: String?) : WakeEvent
    data class TurnChanged(val progress: TurnProgress) : WakeEvent
}

/** The detector runs while nobody is speaking to or from the phone. */
fun WakeStatus.listensForWakeWord(): Boolean = phase == WakePhase.LISTENING || phase == WakePhase.THINKING

/**
 * WHAT: Pure transition function of the hands-free loop.
 * WHY: Every stop reason stays visible as a detail, so a silent wake word never has to be guessed at.
 */
fun WakeStatus.reduce(event: WakeEvent): WakeStatus = when (event) {
    WakeEvent.Start -> WakeStatus(WakePhase.LISTENING, detections = detections)
    WakeEvent.Stop -> WakeStatus(WakePhase.OFF, detections = detections)
    is WakeEvent.Blocked -> copy(phase = WakePhase.BLOCKED, turnId = null, detail = event.reason)
    is WakeEvent.Detected -> if (listensForWakeWord()) {
        copy(
            phase = WakePhase.CAPTURING,
            turnId = null,
            detail = "",
            lastDetectionScore = event.score,
            detections = detections + 1,
        )
    } else {
        this
    }
    is WakeEvent.CaptureEnded -> captureEnded(event)
    is WakeEvent.TurnChanged -> if (tracksTurn()) followTurn(event.progress) else this
}

private fun WakeStatus.tracksTurn(): Boolean =
    turnId != null && (phase == WakePhase.SENDING || phase == WakePhase.THINKING || phase == WakePhase.SPEAKING)

private fun WakeStatus.captureEnded(event: WakeEvent.CaptureEnded): WakeStatus {
    if (phase != WakePhase.CAPTURING) return this
    return when {
        event.end == UtteranceEnd.NO_SPEECH -> listening("Heard the wake word but no question")
        event.turnId == null -> listening("Could not send the question")
        else -> copy(phase = WakePhase.SENDING, turnId = event.turnId, detail = "")
    }
}

private fun WakeStatus.followTurn(progress: TurnProgress): WakeStatus = when (progress.stage) {
    TurnStage.SENDING -> copy(phase = WakePhase.SENDING)
    TurnStage.THINKING -> copy(phase = WakePhase.THINKING)
    TurnStage.SPEAKING -> copy(phase = WakePhase.SPEAKING)
    TurnStage.SPOKEN -> listening("")
    TurnStage.SEND_FAILED -> listening("Could not send · ${progress.error}")
    TurnStage.REPLY_FAILED -> listening("No reply · ${progress.error}")
    TurnStage.SPEAK_FAILED -> listening("Could not read the reply · ${progress.error}")
    TurnStage.GONE -> listening("The question left local history")
}

private fun WakeStatus.listening(detail: String): WakeStatus =
    copy(phase = WakePhase.LISTENING, turnId = null, detail = detail)
