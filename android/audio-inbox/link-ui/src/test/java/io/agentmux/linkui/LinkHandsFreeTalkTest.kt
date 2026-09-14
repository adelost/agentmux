package io.agentmux.linkui

import io.agentmux.wakeword.WakeHearing
import io.agentmux.wakeword.WakePhase
import io.agentmux.wakeword.WakePhrases
import io.agentmux.wakeword.WakeStatus
import org.junit.Assert.assertEquals
import org.junit.Test

// Mattias 2026-09-14: see when it activates and listens, like holding HOLD TO TALK, see the timeout, and keep text minimal.
class LinkHandsFreeTalkTest {
    private fun talk(phase: WakePhase, hearing: WakeHearing? = null) = linkHandsFreeTalk(WakeStatus(phase = phase, hearing = hearing))

    @Test
    fun theTalkRingWalksThroughArmedListeningCountdownAndSendingWithOneWordEach() {
        assertEquals(LinkHandsFreeTalk("HOLD TO TALK", "\"HEY JARVIS\"", null, recording = false), talk(WakePhase.LISTENING))
        assertEquals(LinkHandsFreeTalk("LISTENING", "", null, recording = true), talk(WakePhase.CAPTURING))
        assertEquals(
            LinkHandsFreeTalk("LISTENING", "", null, recording = true),
            talk(WakePhase.CAPTURING, WakeHearing(0.7f, heardSpeech = true, sendsInMs = null)),
        )
        assertEquals(
            LinkHandsFreeTalk("LISTENING", "", "2", recording = true),
            talk(WakePhase.CAPTURING, WakeHearing(0.1f, heardSpeech = true, sendsInMs = 1_900)),
        )
        assertEquals(
            LinkHandsFreeTalk("SENDING", "", null, recording = false),
            talk(WakePhase.CAPTURING, WakeHearing(0f, heardSpeech = true, sendsInMs = 0)),
        )
        assertEquals(LinkHandsFreeTalk("LISTENING", "", null, recording = true), talk(WakePhase.FOLLOW_UP))
        assertEquals(LinkHandsFreeTalk("SENDING", "", null, recording = false), talk(WakePhase.SENDING))
    }

    @Test
    fun theArmedHintNamesTheChosenPhrase() {
        assertEquals("\"ALEXA\"", linkHandsFreeTalk(WakeStatus(phase = WakePhase.LISTENING, phrase = WakePhrases.ALEXA))?.sub)
    }

    @Test
    fun withHandsFreeOffOrStoppedTheRingIsPlainHoldToTalk() {
        assertEquals(null, talk(WakePhase.OFF))
        assertEquals(null, talk(WakePhase.BLOCKED))
    }
}
