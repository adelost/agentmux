package io.agentmux.audioinbox.wear

import org.junit.Assert.assertEquals
import org.junit.Test

class WearTtsPlayerTest {
    @Test
    fun requestDecisionNeverQueuesAfterInitializationFailed() {
        assertEquals(
            TtsRequestDecision.QUEUE,
            ttsRequestDecision(TtsEngineState.INITIALIZING),
        )
        assertEquals(
            TtsRequestDecision.SPEAK,
            ttsRequestDecision(TtsEngineState.READY),
        )
        assertEquals(
            TtsRequestDecision.FAIL,
            ttsRequestDecision(TtsEngineState.FAILED),
        )
    }
}
