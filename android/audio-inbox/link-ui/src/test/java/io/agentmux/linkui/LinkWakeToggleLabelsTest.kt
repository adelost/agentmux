package io.agentmux.linkui

import io.agentmux.linkui.product.LinkWakePresentation
import io.agentmux.wakeword.WakePhase
import io.agentmux.wakeword.WakePhrases
import io.agentmux.wakeword.WakeSensitivity
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * lsrc:0 S1, 2026-09-19: Settings carried a status line dressed as a row. The toggle says it instead, and
 * what it says has to stay true in every phase, not only while the loop is listening.
 */
class LinkWakeToggleLabelsTest {
    private fun wake(phase: WakePhase) = LinkWakePresentation(
        phase, null, detections = 0, phrase = WakePhrases.HEY_MARVIN, sensitivity = WakeSensitivity.NORMAL,
    )

    @Test
    fun listeningNamesThePhraseItIsListeningFor() {
        assertEquals("OFF" to "ON · listening for \"Hey Marvin\"", linkWakeToggleLabels(wake(WakePhase.LISTENING)))
    }

    @Test
    fun everyOtherPhaseSaysOnlyOnBecauseTheMainPageReportsTheRest() {
        WakePhase.entries.filter { it != WakePhase.LISTENING }.forEach { phase ->
            assertEquals(phase.name, "OFF" to "ON", linkWakeToggleLabels(wake(phase)))
        }
    }

    // The label is the choice's own option, so a label that does not come back would break the toggle.
    @Test
    fun theTwoLabelsAreAlwaysDistinct() {
        WakePhase.entries.forEach { phase ->
            val (off, on) = linkWakeToggleLabels(wake(phase))
            assertEquals(phase.name, 2, setOf(off, on).size)
        }
    }
}
