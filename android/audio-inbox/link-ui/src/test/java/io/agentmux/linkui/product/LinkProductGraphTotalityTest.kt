package io.agentmux.linkui.product

import com.adelost.releasekit.UpdateState
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTargetKind
import io.agentmux.linkcore.CaptureOperation
import io.agentmux.linkcore.CapturePhase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import com.adelost.ringkit.ports.CirclePortRole
import com.adelost.ringkit.ports.CirclePortStatus
import com.adelost.ringkit.ports.needsAttention
import com.adelost.ringkit.ports.status
import io.agentmux.linkui.product.generated.GeneratedLinkPortTrace
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LinkProductGraphTotalityTest {
    @Test
    fun aRealGraphCommandRecordsOneReturnedPortWithoutRecordingStatePublication() {
        val rows = mutableListOf<String>()
        GeneratedLinkPortTrace.observer = { rows += it }
        val graph = graph(
            state = MutableStateFlow(LinkState()),
            sinks = LinkProductSinks({}, {}, {}, {}, {}, {}, {}, {}),
        )
        try {
            assertEquals(emptyList<String>(), rows)
            graph.onTalkCommand(LinkCaptureCommandEvent(CaptureOperation.BEGIN))
            assertEquals(
                listOf("""{"kind":"port","portRef":"capture.talk.command","phase":"returned"}"""),
                rows,
            )
        } finally {
            graph.close()
            GeneratedLinkPortTrace.observer = null
        }
    }

    @Test
    fun servicesFlowThroughFinalPresentationsIntoComponents() {
        val state = MutableStateFlow(LinkState())
        val playback = mutableListOf<LinkPlaybackCommandEvent>()
        val captures = mutableListOf<CaptureOperation>()
        var clock = 0L
        val graph = graph(
            state = state,
            sinks = LinkProductSinks(
                captureCommand = { event ->
                    captures += event.operation
                    state.value = state.value.copy(capture = if (event.operation == CaptureOperation.BEGIN)
                        CapturePhase.LISTENING else CapturePhase.IDLE)
                },
                capturedTurn = {},
                compose = {},
                playbackCommand = { playback += it },
                targetSelect = {},
                preferenceToggle = {},
                historyClear = {},
                updateCommand = {},
            ),
            clock = { clock },
        )

        try {
            assertEquals(ConnectionState.OFF, graph.connection.value.connection)
            assertEquals(DeliveryPhase.NONE, graph.latest.value.deliveryPhase)
            assertEquals(LinkTargetKind.NONE, graph.target.value.kind)
            assertEquals(LinkRoute.HOME, graph.activePage.value)
            graph.onSettingsActionOpen(LinkRouteOpenEvent(LinkRoute.SETTINGS))
            assertEquals(LinkRoute.SETTINGS, graph.activePage.value)
            graph.onDevHostOpen(LinkRouteOpenEvent(LinkRoute.DEV_HOST))
            assertEquals(LinkRoute.DEV_HOST, graph.activePage.value)
            val older = io.agentmux.linkcore.LinkTurn("older", "same-id", "Old label", "Question",
                createdAtMs = 1L, replyText = "Earlier reply")
            state.value = state.value.copy(turns = listOf(older), selectedTargetId = "same-id")
            val selected = io.agentmux.linkui.linkConversationTurns(graph.latest.value.turns, "same-id").single()
            val action = io.agentmux.linkui.linkReadAloudRow(selected) { operation, id ->
                graph.onActivePlaybackCommand(LinkPlaybackCommandEvent(operation, id))
            }!!
            state.value = state.value.copy(turns = listOf(older, older.copy(turnId = "newer")))
            action.onTap!!()
            assertEquals(listOf(LinkPlaybackCommandEvent(io.agentmux.linkcore.PlaybackOperation.PLAY, "older")), playback)
            assertEquals(true, graph.beginCapture()) // no startup delay
            clock += 499_000_000L
            graph.releaseCapture()
            assertEquals(listOf(CaptureOperation.BEGIN, CaptureOperation.CANCEL), captures)
            graph.beginCapture()
            clock += 500_000_000L
            graph.releaseCapture()
            graph.releaseCapture() // duplicate UP is not a second submission
            assertEquals(listOf(CaptureOperation.BEGIN, CaptureOperation.CANCEL,
                CaptureOperation.BEGIN, CaptureOperation.RELEASE), captures)
        } finally {
            graph.close()
        }
    }

    @Test
    fun aFreshLinkShowsUnsentCommandsAsIdleAndNothingNeedsAttention() {
        val graph = graph(
            state = MutableStateFlow(LinkState()),
            sinks = LinkProductSinks({}, {}, {}, {}, {}, {}, {}, {}),
        )
        try {
            val ports = runBlocking { graph.inspections.first() }
            val commands = ports.filter { it.role == CirclePortRole.COMMAND }
            assertTrue(commands.isNotEmpty())
            assertEquals(emptyList<String>(), commands.filter { it.status() != CirclePortStatus.IDLE }.map { "${it.id}=${it.status()}" })
            assertEquals(emptyList<String>(), ports.filter { it.needsAttention() }.map { it.id })
        } finally {
            graph.close()
        }
    }

    @Test
    fun listeningCueSoundFlowsThroughTheExistingPreferencesPort() {
        val cueSound = MutableStateFlow(true)
        val graph = graph(
            state = MutableStateFlow(LinkState()),
            sinks = LinkProductSinks({}, {}, {}, {}, {}, {}, {}, {}),
            cueSound = cueSound,
        )
        try {
            assertEquals(true, graph.preferences.value.listeningCueSound)
            cueSound.value = false
            assertEquals(false, graph.preferences.value.listeningCueSound)
        } finally {
            graph.close()
        }
    }

    private fun graph(
        state: MutableStateFlow<LinkState>,
        sinks: LinkProductSinks,
        clock: () -> Long = { 0L },
        cueSound: MutableStateFlow<Boolean> = MutableStateFlow(true),
    ) = LinkProductGraph(
        processScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
        state = state,
        updateState = MutableStateFlow(
            UpdateState.UpToDate("test", publishedAtEpochMillis = null),
        ),
        microphoneGranted = MutableStateFlow(false),
        speakReplies = MutableStateFlow(false),
        wakeWordEnabled = MutableStateFlow(false),
        listeningCueSound = cueSound,
        wakeStatus = MutableStateFlow(io.agentmux.wakeword.WakeStatus()),
        publicLinkActive = { false },
        targetKindOf = { null },
        captureByteCount = { 0L },
        captureByteLimit = { null },
        capturedTurns = MutableSharedFlow(),
        navigation = LinkNavigationController(
            artifact = io.agentmux.linkui.product.generated.GeneratedLinkArtifactRef.PHONE_FULL_UI,
        ),
        sinks = sinks,
        monotonicNanos = clock,
    )
}
