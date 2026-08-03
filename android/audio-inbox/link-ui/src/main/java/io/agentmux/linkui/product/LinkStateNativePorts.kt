package io.agentmux.linkui.product

import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.ReplyPhase
import io.agentmux.linkui.product.generated.LinkAcceptedTurn
import io.agentmux.linkui.product.generated.LinkDeliveryState
import io.agentmux.linkui.product.generated.LinkPlaybackCommand
import io.agentmux.linkui.product.generated.LinkPlaybackState
import io.agentmux.linkui.product.generated.LinkReadyReply
import io.agentmux.linkui.product.generated.LinkReplyState
import io.agentmux.linkui.product.generated.LinkRouteCommand
import io.agentmux.linkui.product.generated.LinkRouteState
import io.agentmux.linkui.product.generated.NavigationServicePort
import io.agentmux.linkui.product.generated.PlaybackServicePort
import io.agentmux.linkui.product.generated.ReplyServicePort

class LinkNavigationNativePort(
    private val current: () -> String,
    private val navigate: (String) -> Unit,
) : NavigationServicePort {
    override fun open(value: LinkRouteCommand) = navigate(value.route)

    override fun destination(): LinkRouteState = LinkRouteState(current())
}

class LinkStateReplyServicePort(
    private val state: () -> LinkState,
) : ReplyServicePort {
    override fun accepted(value: LinkAcceptedTurn) {
        check(state().turns.any { turn ->
            turn.turnId == value.turnId && turn.targetId == value.targetId
        })
    }

    override fun status(): LinkReplyState {
        val current = state()
        val turn = current.turns.lastOrNull()
        return LinkReplyState(
            turnId = turn?.turnId,
            phase = (turn?.replyPhase ?: ReplyPhase.NONE).name,
            offline = current.connection != ConnectionState.CONNECTED,
        )
    }

    override fun reply(): LinkReadyReply? = state().turns.lastOrNull {
        it.replyPhase == ReplyPhase.READY
    }?.let { turn ->
        LinkReadyReply(
            turnId = turn.turnId,
            body = turn.replyText,
            audioRef = null,
            receivedAtMs = turn.replyReceivedAtMs,
        )
    }
}

class LinkStatePlaybackServicePort(
    private val state: () -> LinkState,
    private val commandHandler: (LinkPlaybackCommand) -> Unit,
) : PlaybackServicePort {
    override fun reply(value: LinkReadyReply) {
        check(state().turns.any { turn ->
            turn.turnId == value.turnId && turn.replyText == value.body
        })
    }

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

fun LinkState.deliveryState(): LinkDeliveryState {
    val turn = turns.lastOrNull()
    return LinkDeliveryState(
        turnId = turn?.turnId,
        phase = turn?.deliveryPhase?.name ?: "IDLE",
        offline = connection != ConnectionState.CONNECTED,
        idempotencyKey = turn?.turnId,
    )
}

fun LinkState.acceptedTurn(): LinkAcceptedTurn? = turns.lastOrNull {
    it.deliveryPhase == DeliveryPhase.QUEUED
}?.let { turn ->
    LinkAcceptedTurn(
        turnId = turn.turnId,
        targetId = turn.targetId,
        idempotencyKey = turn.turnId,
        durablyAccepted = true,
    )
}
