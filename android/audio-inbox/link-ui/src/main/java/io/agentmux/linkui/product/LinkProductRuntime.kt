package io.agentmux.linkui.product

import io.agentmux.linkui.product.generated.LinkCaptureCommand
import io.agentmux.linkui.product.generated.LinkNativePortGraph
import io.agentmux.linkui.product.generated.LinkPlaybackCommand
import io.agentmux.linkui.product.generated.LinkProductWiring
import io.agentmux.linkui.product.generated.LinkRoute
import io.agentmux.linkui.product.generated.LinkRouteCommand

/** Executes user intents through the typed native ports emitted from ProductConfig. */
class LinkProductRuntime(
    private val ports: LinkNativePortGraph,
) {
    fun open(route: LinkRoute): LinkRoute {
        ports.navigation.open(LinkRouteCommand(route.id))
        return LinkRoute.entries.single { it.id == ports.navigation.destination().route }
    }

    fun beginCapture(): Boolean {
        ports.capture.command(LinkCaptureCommand(CAPTURE_BEGIN))
        return ports.capture.status().phase == CAPTURE_LISTENING
    }

    fun releaseCapture() {
        ports.capture.command(LinkCaptureCommand(CAPTURE_RELEASE))
        ports.capture.captured()?.let { captured ->
            check(
                LinkProductWiring.CAPTURE_CAPTURED_TO_CONVERSATION_TURN in
                    LinkProductWiring.all,
            )
            ports.conversation.turn(captured)
        }
    }

    fun cancelCapture() {
        ports.capture.command(LinkCaptureCommand(CAPTURE_CANCEL))
    }

    fun play(turnId: String) = playback(PLAYBACK_PLAY, turnId)

    fun pause(turnId: String) = playback(PLAYBACK_PAUSE, turnId)

    fun resume(turnId: String) = playback(PLAYBACK_RESUME, turnId)

    fun stop(turnId: String) = playback(PLAYBACK_STOP, turnId)

    private fun playback(operation: String, turnId: String) {
        ports.playback.command(LinkPlaybackCommand(operation, turnId))
    }

    private companion object {
        const val CAPTURE_BEGIN = "BEGIN"
        const val CAPTURE_RELEASE = "RELEASE"
        const val CAPTURE_CANCEL = "CANCEL"
        const val CAPTURE_LISTENING = "LISTENING"
        const val PLAYBACK_PLAY = "PLAY"
        const val PLAYBACK_PAUSE = "PAUSE"
        const val PLAYBACK_RESUME = "RESUME"
        const val PLAYBACK_STOP = "STOP"
    }
}
