package io.agentmux.audioinbox

import io.agentmux.linkui.product.LinkWakePresentation
import io.agentmux.linkui.product.wakePhaseGlyph
import io.agentmux.wakeword.WakePhase
import io.agentmux.wakeword.WakePhrases
import io.agentmux.wakeword.WakeSensitivity
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The main page's wake row, held to what it says rather than to how it is built.
 * lsrc:0 M1 and M4, 2026-09-19: the row is titled by the phrase, its second line leads with the declared
 * phase word, and a wake word that is on but cannot hear is never shown as off.
 */
class WakeRowTest {
    private fun wake(phase: WakePhase, detail: String? = null) = LinkWakePresentation(
        phase, detail, detections = 0, phrase = WakePhrases.HEY_JARVIS, sensitivity = WakeSensitivity.NORMAL,
    )

    @Test
    fun everyPhaseLeadsWithItsDeclaredWord() {
        WakePhase.entries.forEach { phase ->
            val sub = wakeRowDetail(wake(phase), sendsInMs = null)
            assertEquals(phase.name, io.agentmux.linkui.product.wakePhaseWord(phase), sub.substringBefore(" ·"))
        }
    }

    @Test
    fun theTwoTappableStatesSayWhichTapTheyTake() {
        assertEquals("OFF · tap to listen", wakeRowDetail(wake(WakePhase.OFF), null))
        assertEquals("LISTENING · tap to stop", wakeRowDetail(wake(WakePhase.LISTENING), null))
    }

    @Test
    fun hearingCountsDownInWholeSecondsAndNeverShowsATrailingSeparator() {
        assertEquals("HEARING · 3 s", wakeRowDetail(wake(WakePhase.CAPTURING), sendsInMs = 2_400))
        assertEquals("HEARING", wakeRowDetail(wake(WakePhase.CAPTURING), sendsInMs = null))
    }

    @Test
    fun blockedCarriesTheLoopsOwnReasonAndNeverOneInventedHere() {
        assertEquals(
            "BLOCKED · $MICROPHONE_NEEDED",
            wakeRowDetail(wake(WakePhase.BLOCKED, MICROPHONE_NEEDED), null),
        )
        assertEquals(
            "BLOCKED · Microphone in use",
            wakeRowDetail(wake(WakePhase.BLOCKED, "Microphone in use"), null),
        )
        assertEquals("BLOCKED", wakeRowDetail(wake(WakePhase.BLOCKED), null))
    }

    // One grouping, two surfaces: the status bar and this row read the same declared glyph, and the
    // drawable each one maps to is the same drawable.
    @Test
    fun phasesThatShareADeclaredGlyphShareADrawable() {
        val drawables = WakePhase.entries.map(::wakeGlyphDrawable).toSet()
        assertEquals(3, drawables.size)
        WakePhase.entries.groupBy(::wakePhaseGlyph).forEach { (glyph, phases) ->
            assertEquals(glyph.name, 1, phases.map(::wakeGlyphDrawable).toSet().size)
        }
    }

    // The defect itself: the preference stays on when the permission goes, so the loop never starts and
    // every surface used to read OFF. On and unable to hear must reach the wearer as BLOCKED.
    @Test
    fun onWithoutTheMicrophoneBlocksInsteadOfLookingOff() {
        assertEquals(
            WakeResumeAction.BLOCK_ON_PERMISSION,
            wakeResumeAction(enabled = true, microphoneGranted = false, phase = WakePhase.OFF),
        )
        assertEquals(
            WakeResumeAction.BLOCK_ON_PERMISSION,
            wakeResumeAction(enabled = true, microphoneGranted = false, phase = WakePhase.LISTENING),
        )
    }

    @Test
    fun aPermissionThatComesBackStartsTheLoopAgainFromBlocked() {
        assertEquals(
            WakeResumeAction.START,
            wakeResumeAction(enabled = true, microphoneGranted = true, phase = WakePhase.BLOCKED),
        )
        assertEquals(
            WakeResumeAction.START,
            wakeResumeAction(enabled = true, microphoneGranted = true, phase = WakePhase.OFF),
        )
    }

    @Test
    fun aRunningLoopAndAnOffPreferenceAreBothLeftAlone() {
        assertEquals(
            WakeResumeAction.NOTHING,
            wakeResumeAction(enabled = true, microphoneGranted = true, phase = WakePhase.LISTENING),
        )
        assertEquals(
            WakeResumeAction.NOTHING,
            wakeResumeAction(enabled = false, microphoneGranted = true, phase = WakePhase.OFF),
        )
        assertEquals(
            WakeResumeAction.NOTHING,
            wakeResumeAction(enabled = false, microphoneGranted = false, phase = WakePhase.BLOCKED),
        )
    }
}
