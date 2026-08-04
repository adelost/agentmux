package io.agentmux.linkui.product

import io.agentmux.linkui.product.generated.CaptureServicePort
import io.agentmux.linkui.product.generated.ConversationServicePort
import io.agentmux.linkui.product.generated.LinkArtifactProfile
import io.agentmux.linkui.product.generated.LinkCaptureCommand
import io.agentmux.linkui.product.generated.LinkCaptureOperation
import io.agentmux.linkui.product.generated.LinkCapturePhase
import io.agentmux.linkui.product.generated.LinkCapturedTurn
import io.agentmux.linkui.product.generated.HistoryServicePort
import io.agentmux.linkui.product.generated.LinkCaptureState
import io.agentmux.linkui.product.generated.LinkComponentId
import io.agentmux.linkui.product.generated.LinkConnectionState
import io.agentmux.linkui.product.generated.LinkConversationState
import io.agentmux.linkui.product.generated.LinkDeliveryPhase
import io.agentmux.linkui.product.generated.LinkHistoryState
import io.agentmux.linkui.product.generated.LinkNativePortGraph
import io.agentmux.linkui.product.generated.LinkPlaybackCommand
import io.agentmux.linkui.product.generated.LinkPlaybackPhase
import io.agentmux.linkui.product.generated.LinkPlaybackState
import io.agentmux.linkui.product.generated.LinkPreferenceKey
import io.agentmux.linkui.product.generated.LinkPreferenceToggle
import io.agentmux.linkui.product.generated.LinkPreferencesState
import io.agentmux.linkui.product.generated.LinkProductManifest
import io.agentmux.linkui.product.generated.LinkRecoveryPhase
import io.agentmux.linkui.product.generated.LinkRecoveryState
import io.agentmux.linkui.product.generated.LinkReplyPhase
import io.agentmux.linkui.product.generated.LinkRoute
import io.agentmux.linkui.product.generated.LinkRouteCommand
import io.agentmux.linkui.product.generated.LinkRouteState
import io.agentmux.linkui.product.generated.LinkSessionState
import io.agentmux.linkui.product.generated.LinkTargetKind
import io.agentmux.linkui.product.generated.LinkTargetSelect
import io.agentmux.linkui.product.generated.LinkTargetState
import io.agentmux.linkui.product.generated.LinkTextTurn
import io.agentmux.linkui.product.generated.LinkUpdateCommand
import io.agentmux.linkui.product.generated.LinkUpdateOperation
import io.agentmux.linkui.product.generated.LinkUpdatePhase
import io.agentmux.linkui.product.generated.LinkUpdateState
import io.agentmux.linkui.product.generated.NavigationServicePort
import io.agentmux.linkui.product.generated.PlaybackServicePort
import io.agentmux.linkui.product.generated.PreferencesServicePort
import io.agentmux.linkui.product.generated.RecoveryServicePort
import io.agentmux.linkui.product.generated.SessionServicePort
import io.agentmux.linkui.product.generated.TargetServicePort
import io.agentmux.linkui.product.generated.UpdatesServicePort
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LinkProductContractTest {
    @Test
    fun `one generated product binds both artifacts and routes a typed native turn`() {
        LinkArtifactProfile.entries.forEach { profile ->
            val product = LinkProductSession(profile)
            profile.surfaces.forEach { surface ->
                assertTrue(product.components(LinkRoute.HOME, surface).isNotEmpty())
                assertTrue(product.components(LinkRoute.SETTINGS, surface).isNotEmpty())
            }
        }
        assertEquals(
            setOf(
                "navigation", "capture", "conversation", "playback",
                "target", "session", "history", "preferences", "updates", "recovery",
            ),
            LinkProductManifest.services.map { it.id }.toSet(),
        )
        assertEquals("durable", LinkProductManifest.services.single { it.id == "conversation" }.durability)
        assertEquals("wall", LinkProductManifest.services.single { it.id == "conversation" }.clockDomain)
        // Total component↔service wiring: every component either binds typed
        // ui-entry portRefs or carries a named framework reason.
        LinkComponentId.entries.forEach { component ->
            val wiring = LinkProductManifest.wiring(component)
            assertTrue(wiring.uiEntries.isNotEmpty() || wiring.frameworkReason != null)
        }

        val graph = FakeNativePortGraph()
        val runtime = LinkProductRuntime(graph)
        assertTrue(runtime.beginCapture())
        runtime.releaseCapture()
        assertEquals(graph.captured, graph.delivered)
    }
}

private class FakeNativePortGraph : LinkNativePortGraph {
    val captured = LinkCapturedTurn(
        turnId = "turn-7",
        targetId = "agent-3",
        payloadRef = "memory://turn-7",
        idempotencyKey = "turn-7",
        createdAtMs = 1_700_000_000_000L,
    )
    var delivered: LinkCapturedTurn? = null
    private var capturePhase = LinkCapturePhase.IDLE

    override val navigation = object : NavigationServicePort {
        private var route = LinkRoute.HOME
        override fun open(value: LinkRouteCommand) { route = value.route }
        override fun destination() = LinkRouteState(route)
    }
    override val capture = object : CaptureServicePort {
        override fun command(value: LinkCaptureCommand) {
            capturePhase = when (value.operation) {
                LinkCaptureOperation.BEGIN -> LinkCapturePhase.LISTENING
                LinkCaptureOperation.RELEASE -> LinkCapturePhase.FINALIZING
                LinkCaptureOperation.CANCEL -> LinkCapturePhase.IDLE
            }
        }
        override fun status() = LinkCaptureState(capturePhase, 42L, 512L)
        override fun captured() = captured.takeIf { capturePhase == LinkCapturePhase.FINALIZING }
    }
    override val conversation = object : ConversationServicePort {
        override fun turn(value: LinkCapturedTurn) { delivered = value }
        override fun compose(value: LinkTextTurn) = Unit
        override fun status() = LinkConversationState(
            delivered?.turnId,
            LinkDeliveryPhase.QUEUED,
            LinkReplyPhase.THINKING,
            false,
            delivered?.idempotencyKey,
        )
    }
    override val playback = object : PlaybackServicePort {
        override fun command(value: LinkPlaybackCommand) = Unit
        override fun status() = LinkPlaybackState(null, LinkPlaybackPhase.IDLE, 0L, 0L)
    }
    override val target = object : TargetServicePort {
        private var selected = "agent-3"
        override fun select(value: LinkTargetSelect) { selected = value.targetId }
        override fun directory() = LinkTargetState(selected, LinkTargetKind.AGENT, 1L)
    }
    override val session = object : SessionServicePort {
        override fun status() = LinkSessionState(LinkConnectionState.CONNECTED, "TAILNET", false)
    }
    override val history = object : HistoryServicePort {
        override fun status() = LinkHistoryState(1L, 50L)
    }
    override val preferences = object : PreferencesServicePort {
        private var handsFree = false
        private var speakReplies = false
        override fun toggle(value: LinkPreferenceToggle) = when (value.key) {
            LinkPreferenceKey.HANDS_FREE -> { handsFree = value.enabled }
            LinkPreferenceKey.SPEAK_REPLIES -> { speakReplies = value.enabled }
        }
        override fun status() = LinkPreferencesState(handsFree, speakReplies)
    }
    override val updates = object : UpdatesServicePort {
        private var phase = LinkUpdatePhase.IDLE
        override fun command(value: LinkUpdateCommand) {
            phase = when (value.operation) {
                LinkUpdateOperation.CHECK, LinkUpdateOperation.RETRY -> LinkUpdatePhase.CHECKING
                LinkUpdateOperation.INSTALL -> LinkUpdatePhase.INSTALLING
            }
        }
        override fun status() = LinkUpdateState(phase)
    }
    override val recovery = object : RecoveryServicePort {
        override fun status() = LinkRecoveryState(LinkRecoveryPhase.CLEAN, null)
    }
}
