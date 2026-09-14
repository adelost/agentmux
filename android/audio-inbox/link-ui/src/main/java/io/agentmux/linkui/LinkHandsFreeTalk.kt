package io.agentmux.linkui

import io.agentmux.wakeword.WakePhase
import io.agentmux.wakeword.WakeStatus

/** What the talk ring says while hands-free is on. [recording] draws it exactly like holding HOLD TO TALK. */
data class LinkHandsFreeTalk(val label: String, val sub: String, val centerValue: String?, val recording: Boolean)

/**
 * WHAT: The talk ring's one word per hands-free phase; the waveform and the countdown digit carry the rest.
 * WHY: Mattias 2026-09-14: see when the wake word activates and listens, like holding the button, and see the
 * timeout, "inte för mycket onödig text". Null means hands-free is off or stopped: plain HOLD TO TALK.
 */
fun linkHandsFreeTalk(wake: WakeStatus): LinkHandsFreeTalk? {
    val secondsLeft = wake.hearing?.sendsInMs?.let { (it + 999) / 1_000 }
    return when (wake.phase) {
        WakePhase.OFF, WakePhase.BLOCKED -> null
        WakePhase.LISTENING, WakePhase.THINKING, WakePhase.SPEAKING ->
            LinkHandsFreeTalk("HOLD TO TALK", "\"${wake.phrase.spoken.uppercase()}\"", null, recording = false)
        // The silence ran out: the question is being packed for sending, so never show a 0.
        WakePhase.CAPTURING, WakePhase.FOLLOW_UP -> if (secondsLeft == 0) sending
        else LinkHandsFreeTalk("LISTENING", "", secondsLeft?.toString(), recording = true)
        WakePhase.SENDING -> sending
    }
}

private val sending = LinkHandsFreeTalk("SENDING", "", null, recording = false)
