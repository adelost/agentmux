package io.agentmux.linkui.product

import io.agentmux.linkui.product.generated.CaptureServicePort
import io.agentmux.linkui.product.generated.ConversationServicePort
import io.agentmux.linkui.product.generated.LinkArtifactProfile
import io.agentmux.linkui.product.generated.LinkCaptureCommand
import io.agentmux.linkui.product.generated.LinkCaptureOperation
import io.agentmux.linkui.product.generated.LinkCapturePhase
import io.agentmux.linkui.product.generated.LinkCapturedTurn
import io.agentmux.linkui.product.generated.LinkCaptureState
import io.agentmux.linkui.product.generated.LinkConversationState
import io.agentmux.linkui.product.generated.LinkDeliveryPhase
import io.agentmux.linkui.product.generated.LinkNativePortGraph
import io.agentmux.linkui.product.generated.LinkPlaybackCommand
import io.agentmux.linkui.product.generated.LinkPlaybackPhase
import io.agentmux.linkui.product.generated.LinkPlaybackState
import io.agentmux.linkui.product.generated.LinkProductManifest
import io.agentmux.linkui.product.generated.LinkReplyPhase
import io.agentmux.linkui.product.generated.LinkRoute
import io.agentmux.linkui.product.generated.LinkRouteCommand
import io.agentmux.linkui.product.generated.LinkRouteState
import io.agentmux.linkui.product.generated.NavigationServicePort
import io.agentmux.linkui.product.generated.PlaybackServicePort
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
            setOf("navigation", "capture", "conversation", "playback"),
            LinkProductManifest.services.map { it.id }.toSet(),
        )
        assertEquals("durable", LinkProductManifest.services.single { it.id == "conversation" }.durability)
        assertEquals("wall", LinkProductManifest.services.single { it.id == "conversation" }.clockDomain)

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
}
