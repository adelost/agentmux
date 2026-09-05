package io.agentmux.linkui.product

import com.adelost.releasekit.UpdateState
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTargetKind
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Test

class LinkProductGraphTotalityTest {
    @Test
    fun servicesFlowThroughFinalPresentationsIntoComponents() {
        val state = MutableStateFlow(LinkState())
        val playback = mutableListOf<LinkPlaybackCommandEvent>()
        val graph = LinkProductGraph(
            processScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
            state = state,
            updateState = MutableStateFlow(
                UpdateState.UpToDate("test", publishedAtEpochMillis = null),
            ),
            microphoneGranted = MutableStateFlow(false),
            speakReplies = MutableStateFlow(false),
            publicLinkActive = { false },
            targetKindOf = { null },
            captureByteCount = { 0L },
            captureByteLimit = { null },
            capturedTurns = MutableSharedFlow(),
            navigation = LinkNavigationController(
                artifact = io.agentmux.linkui.product.generated.GeneratedLinkArtifactRef.PHONE_FULL_UI,
            ),
            sinks = LinkProductSinks(
                captureCommand = {},
                capturedTurn = {},
                compose = {},
                playbackCommand = { playback += it },
                targetSelect = {},
                preferenceToggle = {},
                updateCommand = {},
            ),
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
        } finally {
            graph.close()
        }
    }
}
