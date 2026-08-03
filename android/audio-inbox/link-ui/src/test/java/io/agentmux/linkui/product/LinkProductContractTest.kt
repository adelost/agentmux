package io.agentmux.linkui.product

import io.agentmux.linkui.product.generated.CaptureServicePort
import io.agentmux.linkui.product.generated.DeliveryServicePort
import io.agentmux.linkui.product.generated.LinkAcceptedTurn
import io.agentmux.linkui.product.generated.LinkArtifactProfile
import io.agentmux.linkui.product.generated.LinkCaptureCommand
import io.agentmux.linkui.product.generated.LinkCapturedTurn
import io.agentmux.linkui.product.generated.LinkCaptureState
import io.agentmux.linkui.product.generated.LinkDeliveryState
import io.agentmux.linkui.product.generated.LinkNativePortGraph
import io.agentmux.linkui.product.generated.LinkPlaybackCommand
import io.agentmux.linkui.product.generated.LinkPlaybackState
import io.agentmux.linkui.product.generated.LinkProductManifest
import io.agentmux.linkui.product.generated.LinkReadyReply
import io.agentmux.linkui.product.generated.LinkReplyState
import io.agentmux.linkui.product.generated.LinkRoute
import io.agentmux.linkui.product.generated.LinkRouteCommand
import io.agentmux.linkui.product.generated.LinkRouteState
import io.agentmux.linkui.product.generated.NavigationServicePort
import io.agentmux.linkui.product.generated.PlaybackServicePort
import io.agentmux.linkui.product.generated.ReplyServicePort
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
            setOf("navigation", "capture", "delivery", "reply", "playback"),
            LinkProductManifest.services.map { it.id }.toSet(),
        )
        assertEquals("durable", LinkProductManifest.services.single { it.id == "delivery" }.durability)
        assertEquals("wall", LinkProductManifest.services.single { it.id == "reply" }.clockDomain)

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
    private var capturePhase = "IDLE"

    override val navigation = object : NavigationServicePort {
        private var route = LinkRoute.HOME.id
        override fun open(value: LinkRouteCommand) { route = value.route }
        override fun destination() = LinkRouteState(route)
    }
    override val capture = object : CaptureServicePort {
        override fun command(value: LinkCaptureCommand) {
            capturePhase = when (value.operation) {
                "BEGIN" -> "LISTENING"
                "RELEASE" -> "FINALIZING"
                "CANCEL" -> "IDLE"
                else -> error(value.operation)
            }
        }
        override fun status() = LinkCaptureState(capturePhase, 42L, 512L)
        override fun captured() = captured.takeIf { capturePhase == "FINALIZING" }
    }
    override val delivery = object : DeliveryServicePort {
        override fun turn(value: LinkCapturedTurn) { delivered = value }
        override fun status() = LinkDeliveryState(delivered?.turnId, "QUEUED", false, delivered?.idempotencyKey)
        override fun accepted(): LinkAcceptedTurn? = null
    }
    override val reply = object : ReplyServicePort {
        override fun accepted(value: LinkAcceptedTurn) = Unit
        override fun status() = LinkReplyState(null, "NONE", false)
        override fun reply(): LinkReadyReply? = null
    }
    override val playback = object : PlaybackServicePort {
        override fun reply(value: LinkReadyReply) = Unit
        override fun command(value: LinkPlaybackCommand) = Unit
        override fun status() = LinkPlaybackState(null, "IDLE", 0L, 0L)
    }
}
