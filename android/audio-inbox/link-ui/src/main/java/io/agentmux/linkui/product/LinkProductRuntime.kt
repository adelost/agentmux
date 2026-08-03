package io.agentmux.linkui.product

import io.agentmux.linkui.product.generated.LinkCaptureCommand
import io.agentmux.linkui.product.generated.LinkCaptureOperation
import io.agentmux.linkui.product.generated.LinkCapturePhase
import io.agentmux.linkui.product.generated.LinkNativePortGraph
import io.agentmux.linkui.product.generated.LinkPlaybackCommand
import io.agentmux.linkui.product.generated.LinkPlaybackOperation
import io.agentmux.linkui.product.generated.LinkProductWiring
import io.agentmux.linkui.product.generated.LinkRoute
import io.agentmux.linkui.product.generated.LinkRouteCommand

/** Executes user intents through the typed native ports emitted from ProductConfig. */
class LinkProductRuntime(
    private val ports: LinkNativePortGraph,
) {
    fun open(route: LinkRoute): LinkRoute {
        ports.navigation.open(LinkRouteCommand(route))
        return ports.navigation.destination().route
    }

    fun beginCapture(): Boolean {
        ports.capture.command(LinkCaptureCommand(LinkCaptureOperation.BEGIN))
        return ports.capture.status().phase == LinkCapturePhase.LISTENING
    }

    fun releaseCapture() {
        ports.capture.command(LinkCaptureCommand(LinkCaptureOperation.RELEASE))
        ports.capture.captured()?.let { captured ->
            check(
                LinkProductWiring.CAPTURE_CAPTURED_TO_CONVERSATION_TURN in
                    LinkProductWiring.all,
            )
            ports.conversation.turn(captured)
        }
    }

    fun cancelCapture() {
        ports.capture.command(LinkCaptureCommand(LinkCaptureOperation.CANCEL))
    }

    fun play(turnId: String) = playback(LinkPlaybackOperation.PLAY, turnId)

    fun pause(turnId: String) = playback(LinkPlaybackOperation.PAUSE, turnId)

    fun resume(turnId: String) = playback(LinkPlaybackOperation.RESUME, turnId)

    fun stop(turnId: String) = playback(LinkPlaybackOperation.STOP, turnId)

    private fun playback(operation: LinkPlaybackOperation, turnId: String) {
        ports.playback.command(LinkPlaybackCommand(operation, turnId))
    }
}
