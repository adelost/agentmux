package io.agentmux.linkcore

sealed interface LinkAction {
    data class Connection(
        val state: ConnectionState,
        val detail: String,
        val observedAtMs: Long = 0,
    ) : LinkAction

    data class Targets(val targets: List<LinkTarget>) : LinkAction
    data class SelectTarget(val id: String) : LinkAction
    data class Capture(val phase: CapturePhase, val startedAtMs: Long = 0) : LinkAction
    data class Submit(val turn: LinkTurn) : LinkAction
    data class Accepted(val turnId: String, val visibleText: String) : LinkAction
    data class Reply(
        val turnId: String,
        val respondingTarget: String,
        val text: String,
        val receivedAtMs: Long = 0,
    ) : LinkAction

    data class Playback(val turnId: String, val phase: PlaybackPhase) : LinkAction
    data class PlaybackProgress(
        val turnId: String,
        val positionMs: Long,
        val durationMs: Long,
    ) : LinkAction
    data class DeliveryFailed(val turnId: String, val reason: String) : LinkAction
    data class ReplyFailed(val turnId: String, val reason: String) : LinkAction
    data class PlaybackFailed(val turnId: String, val reason: String) : LinkAction
    data class HandsFree(val enabled: Boolean) : LinkAction
    data class Update(val value: UpdatePresentation) : LinkAction
}

/**
 * WHAT: Maps typed Link actions into immutable cross-device presentation state.
 * WHY: Keeps phone and watch behavior identical without sharing Android UI code.
 */
object LinkReducer {
    fun reduce(state: LinkState, action: LinkAction): LinkState = when (action) {
        is LinkAction.Connection -> state.copy(
            connection = action.state,
            connectionDetail = action.detail,
            connectionObservedAtMs = action.observedAtMs,
        )
        is LinkAction.Targets -> {
            val next = action.targets.distinctBy(LinkTarget::id)
            val selected = state.selectedTargetId.takeIf { id ->
                next.any { it.id == id }
            } ?: next.firstOrNull()?.id.orEmpty()
            state.copy(targets = next, selectedTargetId = selected)
        }
        is LinkAction.SelectTarget -> {
            if (state.targets.none { it.id == action.id }) state
            else state.copy(selectedTargetId = action.id)
        }
        is LinkAction.Capture -> state.copy(
            capture = action.phase,
            captureStartedAtMs = action.startedAtMs.takeIf {
                action.phase == CapturePhase.LISTENING
            } ?: 0,
        )
        is LinkAction.Submit -> state.copy(
            turns = LinkHistoryPolicy.retain(state.turns + action.turn),
        )
        is LinkAction.Accepted -> state.mapTurn(action.turnId) {
            it.copy(
                userText = action.visibleText.ifBlank { it.userText },
                deliveryPhase = DeliveryPhase.QUEUED,
                replyPhase = ReplyPhase.THINKING,
                deliveryError = "",
            )
        }
        is LinkAction.Reply -> state.mapTurn(action.turnId) {
            it.copy(
                respondingTarget = action.respondingTarget,
                replyText = action.text,
                replyReceivedAtMs = action.receivedAtMs,
                replyPhase = ReplyPhase.READY,
                replyError = "",
            )
        }
        is LinkAction.Playback -> state.mapTurn(action.turnId) {
            it.copy(playbackPhase = action.phase, playbackError = "")
        }.copy(
            activePlaybackTurnId = when (action.phase) {
                PlaybackPhase.PLAYING, PlaybackPhase.PAUSED -> action.turnId
                else -> state.activePlaybackTurnId?.takeUnless { it == action.turnId }
            },
        )
        is LinkAction.PlaybackProgress -> state.mapTurn(action.turnId) {
            it.copy(
                playbackPositionMs = action.positionMs.coerceAtLeast(0L),
                playbackDurationMs = action.durationMs.coerceAtLeast(0L),
            )
        }
        is LinkAction.DeliveryFailed -> state.mapTurn(action.turnId) {
            it.copy(deliveryPhase = DeliveryPhase.FAILED, deliveryError = action.reason)
        }
        is LinkAction.ReplyFailed -> state.mapTurn(action.turnId) {
            it.copy(replyPhase = ReplyPhase.FAILED, replyError = action.reason)
        }
        is LinkAction.PlaybackFailed -> state.mapTurn(action.turnId) {
            it.copy(playbackPhase = PlaybackPhase.FAILED, playbackError = action.reason)
        }
        is LinkAction.HandsFree -> state.copy(handsFree = action.enabled)
        is LinkAction.Update -> state.copy(update = action.value)
    }

    private fun LinkState.mapTurn(
        turnId: String,
        transform: (LinkTurn) -> LinkTurn,
    ): LinkState = copy(turns = turns.map { if (it.turnId == turnId) transform(it) else it })
}
