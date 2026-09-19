package io.agentmux.linkui.product

import io.agentmux.linkcore.LinkPreferenceKey
import io.agentmux.linkcore.LinkState
import io.agentmux.linkui.product.generated.GeneratedLinkArtifactRef
import io.agentmux.wakeword.WakePhase
import io.agentmux.wakeword.WakeStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import com.adelost.releasekit.UpdateState
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Mattias 2026-09-19 asked to turn the wake word on and off from the main page. The control there must
 * write the preference Settings writes, not a second one, and it must say where the wake word is in the
 * word the declaration gives rather than a word of its own.
 */
class LinkWakeToggleTest {
    @Test
    fun theMainPageControlWritesThePreferenceSettingsWrites() {
        val toggles = mutableListOf<LinkPreferenceToggleEvent>()
        val graph = graph(preferenceToggle = { toggles += it })
        try {
            graph.onWakeToggle(LinkPreferenceToggleEvent(LinkPreferenceKey.WAKE_WORD, enabled = true))
            graph.onWakeToggle(LinkPreferenceToggleEvent(LinkPreferenceKey.WAKE_WORD, enabled = false))
            assertEquals(
                listOf(
                    LinkPreferenceToggleEvent(LinkPreferenceKey.WAKE_WORD, true),
                    LinkPreferenceToggleEvent(LinkPreferenceKey.WAKE_WORD, false),
                ),
                toggles,
            )
        } finally {
            graph.close()
        }
    }

    @Test
    fun theControlAndTheSettingsListReachTheSameSink() {
        val toggles = mutableListOf<LinkPreferenceToggleEvent>()
        val graph = graph(preferenceToggle = { toggles += it })
        try {
            graph.onWakeToggle(LinkPreferenceToggleEvent(LinkPreferenceKey.WAKE_WORD, enabled = true))
            graph.onPreferencesToggle(LinkPreferenceToggleEvent(LinkPreferenceKey.WAKE_WORD, enabled = true))
            assertEquals(2, toggles.size)
            assertEquals(toggles[0], toggles[1])
        } finally {
            graph.close()
        }
    }

    // The phase is called "capturing" inside and "HEARING" out loud, and only the declaration says so.
    @Test
    fun everyPhaseHasOneDeclaredWordAndCapturingIsNotOneOfThem() {
        assertEquals(
            listOf("OFF", "LISTENING", "HEARING", "SENDING", "THINKING", "SPEAKING", "BLOCKED"),
            WakePhase.entries.map(::wakePhaseWord),
        )
    }

    // Mattias 2026-09-19 read the system's "speak now" microphone as Link hearing him all the time.
    // Three glyphs, and the quiet one is worn by every phase where nothing is being heard.
    @Test
    fun everyPhaseWearsOneOfThreeDeclaredGlyphsAndWaitingHearsNothing() {
        assertEquals(
            mapOf(
                WakePhaseGlyph.WAITING to listOf(WakePhase.OFF, WakePhase.LISTENING, WakePhase.BLOCKED),
                WakePhaseGlyph.HEARING to listOf(WakePhase.CAPTURING, WakePhase.SENDING),
                WakePhaseGlyph.SPEAKING to listOf(WakePhase.THINKING, WakePhase.SPEAKING),
            ),
            WakePhase.entries.groupBy(::wakePhaseGlyph).mapValues { (_, phases) -> phases.sortedBy { it.ordinal } },
        )
    }

    @Test
    fun theControlReadsItsOwnDeclaredPortOntoTheWakePresentation() {
        val wake = MutableStateFlow(WakeStatus())
        val graph = graph(preferenceToggle = {}, wakeStatus = wake)
        try {
            assertEquals(WakePhase.OFF, graph.wakeToggleModel.value.phase)
            wake.value = WakeStatus(phase = WakePhase.CAPTURING)
            assertEquals(WakePhase.CAPTURING, graph.wakeToggleModel.value.phase)
            assertEquals("HEARING", wakePhaseWord(graph.wakeToggleModel.value.phase))
        } finally {
            graph.close()
        }
    }

    private fun graph(
        preferenceToggle: (LinkPreferenceToggleEvent) -> Unit,
        wakeStatus: MutableStateFlow<WakeStatus> = MutableStateFlow(WakeStatus()),
    ) = LinkProductGraph(
        processScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
        state = MutableStateFlow(LinkState()),
        updateState = MutableStateFlow(UpdateState.UpToDate("test", publishedAtEpochMillis = null)),
        microphoneGranted = MutableStateFlow(true),
        speakReplies = MutableStateFlow(false),
        wakeWordEnabled = MutableStateFlow(false),
        wakeStatus = wakeStatus,
        publicLinkActive = { false },
        targetKindOf = { null },
        captureByteCount = { 0L },
        captureByteLimit = { null },
        capturedTurns = MutableSharedFlow(),
        navigation = LinkNavigationController(artifact = GeneratedLinkArtifactRef.PHONE_FULL_UI),
        sinks = LinkProductSinks(
            captureCommand = {},
            capturedTurn = {},
            compose = {},
            playbackCommand = {},
            targetSelect = {},
            preferenceToggle = preferenceToggle,
            historyClear = {},
            updateCommand = {},
        ),
        monotonicNanos = { 0L },
    )
}
