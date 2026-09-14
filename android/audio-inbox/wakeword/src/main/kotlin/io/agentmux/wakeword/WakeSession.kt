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

/** What the microphone hears during one question: the live voice level and how close it is to being sent. */
data class WakeHearing(val level: Float, val heardSpeech: Boolean, val sendsInMs: Int?)

/** Everything the notification, settings row and talk control show about the hands-free loop. */
data class WakeStatus(
    val phase: WakePhase = WakePhase.OFF,
    val turnId: String? = null,
    val detail: String = "",
    val lastDetectionScore: Float = 0f,
    val detections: Int = 0,
    /** Only while a question is being captured; null otherwise. */
    val hearing: WakeHearing? = null,
    val phrase: WakePhrase = WakePhrases.HEY_JARVIS,
)

sealed interface WakeEvent {
    data object Start : WakeEvent
    data object Stop : WakeEvent
    data class Blocked(val reason: String) : WakeEvent
    data class Detected(val score: Float) : WakeEvent
    data class Heard(val hearing: WakeHearing) : WakeEvent
    /** The user picked another phrase; the microphone loop reloads its model. */
    data class PhraseChosen(val phrase: WakePhrase) : WakeEvent
    /** The user tapped the talk ring while a question was being heard: it is dropped, never sent. */
    data object QuestionCancelled : WakeEvent
    /** A finished capture; [turnId] is null when the host could not submit it, with [failure] saying why. */
    data class CaptureEnded(
        val end: UtteranceEnd,
        val turnId: String?,
        val failure: String = "Could not send the question",
    ) : WakeEvent
    data class TurnChanged(val progress: TurnProgress) : WakeEvent
}

/** The detector runs while waiting and while a reply is read, so the word can interrupt it. */
fun WakeStatus.listensForWakeWord(): Boolean =
    phase == WakePhase.LISTENING || phase == WakePhase.THINKING || phase == WakePhase.SPEAKING

/**
 * WHAT: Pure transition function of the hands-free loop.
 * WHY: Every stop reason stays visible as a detail, so a silent wake word never has to be guessed at.
 */
fun WakeStatus.reduce(event: WakeEvent): WakeStatus = when (event) {
    WakeEvent.Start -> WakeStatus(WakePhase.LISTENING, detections = detections, phrase = phrase)
    WakeEvent.Stop -> WakeStatus(WakePhase.OFF, detections = detections, phrase = phrase)
    is WakeEvent.PhraseChosen -> copy(phrase = event.phrase)
    is WakeEvent.Blocked -> copy(phase = WakePhase.BLOCKED, turnId = null, detail = event.reason, hearing = null)
    is WakeEvent.Detected -> if (listensForWakeWord()) {
        copy(
            phase = WakePhase.CAPTURING,
            turnId = null,
            detail = "",
            hearing = null,
            lastDetectionScore = event.score,
            detections = detections + 1,
        )
    } else {
        this
    }
    is WakeEvent.Heard -> if (phase == WakePhase.CAPTURING) copy(hearing = event.hearing) else this
    WakeEvent.QuestionCancelled -> if (phase == WakePhase.CAPTURING) listening(QUESTION_CANCELLED) else this
    is WakeEvent.CaptureEnded -> captureEnded(event)
    is WakeEvent.TurnChanged -> if (tracksTurn()) followTurn(event.progress) else this
}

private fun WakeStatus.tracksTurn(): Boolean =
    turnId != null && (phase == WakePhase.SENDING || phase == WakePhase.THINKING || phase == WakePhase.SPEAKING)

private fun WakeStatus.captureEnded(event: WakeEvent.CaptureEnded): WakeStatus {
    if (phase != WakePhase.CAPTURING) return this
    return when {
        event.end == UtteranceEnd.NO_SPEECH -> listening("Heard the wake word but no question")
        event.turnId == null -> listening(event.failure)
        else -> copy(phase = WakePhase.SENDING, turnId = event.turnId, detail = "", hearing = null)
    }
}

private fun WakeStatus.followTurn(progress: TurnProgress): WakeStatus = when (progress.stage) {
    TurnStage.SENDING -> copy(phase = WakePhase.SENDING)
    TurnStage.THINKING -> copy(phase = WakePhase.THINKING)
    TurnStage.SPEAKING -> copy(phase = WakePhase.SPEAKING)
    // Mattias 2026-09-15: no dialogue. After the reply the microphone waits for the wake phrase again.
    TurnStage.SPOKEN -> listening("")
    TurnStage.SEND_FAILED -> listening("Could not send · ${progress.error}")
    TurnStage.REPLY_FAILED -> listening("No reply · ${progress.error}")
    TurnStage.SPEAK_FAILED -> listening("Could not read the reply · ${progress.error}")
    TurnStage.GONE -> listening("The question left local history")
}

const val QUESTION_CANCELLED = "Cancelled"

/** A capture may still be dropped until the host has submitted it; after SENDING the turn exists. */
fun WakeStatus.questionCancellable(): Boolean = phase == WakePhase.CAPTURING

private fun WakeStatus.listening(detail: String): WakeStatus =
    copy(phase = WakePhase.LISTENING, turnId = null, detail = detail, hearing = null)
