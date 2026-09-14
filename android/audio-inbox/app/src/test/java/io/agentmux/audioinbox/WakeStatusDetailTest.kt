package io.agentmux.audioinbox

import io.agentmux.linkui.product.LinkWakePresentation
import io.agentmux.wakeword.WakePhase
import io.agentmux.wakeword.WakePhrases
import org.junit.Assert.assertEquals
import org.junit.Test

// Mattias 2026-09-14: "inte för mycket AI-snack, inte för mycket onödigt text".
class WakeStatusDetailTest {
    @Test fun theListeningRowShowsOnlyWhyListeningStoppedNeverATuningCounter() {
        val heard = LinkWakePresentation(WakePhase.LISTENING, null, detections = 4, phrase = WakePhrases.HEY_JARVIS)
        assertEquals("", wakeStatusDetail(heard))
        assertEquals("Microphone in use", wakeStatusDetail(heard.copy(detail = "Microphone in use")))
    }
}
