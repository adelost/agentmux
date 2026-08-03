package io.agentmux.linkui.product

import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkui.product.generated.LinkConversationState
import io.agentmux.linkui.product.generated.LinkPlaybackCommand
import io.agentmux.linkui.product.generated.LinkPlaybackState
import io.agentmux.linkui.product.generated.LinkRouteCommand
import io.agentmux.linkui.product.generated.LinkRouteState
import io.agentmux.linkui.product.generated.NavigationServicePort
import io.agentmux.linkui.product.generated.PlaybackServicePort

class LinkNavigationNativePort(
    private val current: () -> String,
    private val navigate: (String) -> Unit,
) : NavigationServicePort {
    override fun open(value: LinkRouteCommand) = navigate(value.route)

    override fun destination(): LinkRouteState = LinkRouteState(current())
}

class LinkStatePlaybackServicePort(
    private val state: () -> LinkState,
    private val commandHandler: (LinkPlaybackCommand) -> Unit,
) : PlaybackServicePort {
    override fun command(value: LinkPlaybackCommand) = commandHandler(value)

    override fun status(): LinkPlaybackState {
        val current = state()
        val turn = current.activePlaybackTurnId?.let { id ->
            current.turns.firstOrNull { it.turnId == id }
        } ?: current.turns.lastOrNull()
        return LinkPlaybackState(
            turnId = turn?.turnId,
            phase = (turn?.playbackPhase ?: PlaybackPhase.IDLE).name,
            positionMs = turn?.playbackPositionMs ?: 0L,
            durationMs = turn?.playbackDurationMs ?: 0L,
        )
    }
}

fun LinkState.conversationState(): LinkConversationState {
    val turn = turns.lastOrNull()
    return LinkConversationState(
        turnId = turn?.turnId,
        deliveryPhase = turn?.deliveryPhase?.name ?: "IDLE",
        replyPhase = turn?.replyPhase?.name ?: "NONE",
        offline = connection != ConnectionState.CONNECTED,
        idempotencyKey = turn?.turnId,
    )
}
