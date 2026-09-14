package io.agentmux.linkui

import io.agentmux.wakeword.WakePhase
import io.agentmux.wakeword.WakeStatus

/** What the talk ring says while hands-free is on. [recording] draws it exactly like holding HOLD TO TALK. */
data class LinkHandsFreeTalk(val label: String, val sub: String, val centerValue: String?, val recording: Boolean)

/**
 * WHAT: The talk ring's words for each hands-free phase, including the countdown before a paused question is sent.
 * WHY: Mattias 2026-09-14: see when the wake word activates and listens, like holding the button, and see the timeout.
 * Null means hands-free is off or stopped, so the ring is plain HOLD TO TALK.
 */
fun linkHandsFreeTalk(wake: WakeStatus): LinkHandsFreeTalk? {
    val hearing = wake.hearing
    val secondsLeft = hearing?.sendsInMs?.let { (it + 999) / 1_000 }
    return when (wake.phase) {
        WakePhase.OFF, WakePhase.BLOCKED -> null
        WakePhase.LISTENING, WakePhase.THINKING, WakePhase.SPEAKING ->
            LinkHandsFreeTalk("HOLD TO TALK", "OR SAY \"${LinkWakePhrase.spoken.uppercase()}\"", null, recording = false)
        // The silence ran out: the question is being packed for sending, so never show "SENDING IN 0 S".
        WakePhase.CAPTURING, WakePhase.FOLLOW_UP -> if (secondsLeft == 0) sending else LinkHandsFreeTalk(
            label = "LISTENING",
            sub = when {
                secondsLeft != null -> "SENDING IN $secondsLeft S"
                hearing?.heardSpeech == true -> "PAUSE TO SEND"
                wake.phase == WakePhase.FOLLOW_UP -> "ASK A FOLLOW-UP"
                else -> "SPEAK NOW"
            },
            centerValue = secondsLeft?.toString(),
            recording = true,
        )
        WakePhase.SENDING -> sending
    }
}

private val sending = LinkHandsFreeTalk("SENDING", "", null, recording = false)
