package io.agentmux.linkui

import io.agentmux.wakeword.WakeHearing
import io.agentmux.wakeword.WakePhase
import io.agentmux.wakeword.WakeStatus
import org.junit.Assert.assertEquals
import org.junit.Test

// Mattias 2026-09-14: see when it activates and listens, like holding HOLD TO TALK, and see the timeout before it sends.
class LinkHandsFreeTalkTest {
    private fun talk(phase: WakePhase, hearing: WakeHearing? = null) = linkHandsFreeTalk(WakeStatus(phase = phase, hearing = hearing))

    @Test
    fun theTalkRingWalksThroughArmedListeningCountdownAndSending() {
        assertEquals(LinkHandsFreeTalk("HOLD TO TALK", "OR SAY \"HEY JARVIS\"", null, recording = false), talk(WakePhase.LISTENING))
        assertEquals(LinkHandsFreeTalk("LISTENING", "SPEAK NOW", null, recording = true), talk(WakePhase.CAPTURING))
        assertEquals(
            LinkHandsFreeTalk("LISTENING", "PAUSE TO SEND", null, recording = true),
            talk(WakePhase.CAPTURING, WakeHearing(0.7f, heardSpeech = true, sendsInMs = null)),
        )
        assertEquals(
            LinkHandsFreeTalk("LISTENING", "SENDING IN 2 S", "2", recording = true),
            talk(WakePhase.CAPTURING, WakeHearing(0.1f, heardSpeech = true, sendsInMs = 1_900)),
        )
        assertEquals(
            LinkHandsFreeTalk("SENDING", "", null, recording = false),
            talk(WakePhase.CAPTURING, WakeHearing(0f, heardSpeech = true, sendsInMs = 0)),
        )
        assertEquals(LinkHandsFreeTalk("LISTENING", "ASK A FOLLOW-UP", null, recording = true), talk(WakePhase.FOLLOW_UP))
        assertEquals(LinkHandsFreeTalk("SENDING", "", null, recording = false), talk(WakePhase.SENDING))
    }

    @Test
    fun withHandsFreeOffOrStoppedTheRingIsPlainHoldToTalk() {
        assertEquals(null, talk(WakePhase.OFF))
        assertEquals(null, talk(WakePhase.BLOCKED))
    }
}
