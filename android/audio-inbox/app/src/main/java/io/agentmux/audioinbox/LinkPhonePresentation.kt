package io.agentmux.audioinbox

import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.ReplyPhase
import io.agentmux.linkcore.UpdatePresentation

internal fun targetChoices(targets: List<LinkTarget>): List<Pair<String, String>> {
    val baseLabels = targets.associateWith { it.label.ifBlank { it.id }.uppercase() }
    val duplicates = baseLabels.values.groupingBy { it }.eachCount()
    return targets.map { target ->
        val base = requireNotNull(baseLabels[target])
        target.id to if (duplicates.getValue(base) > 1) {
            "$base · ${target.id.uppercase()}"
        } else {
            base
        }
    }
}

internal fun attachmentUrls(text: String): List<String> =
    Regex("""https?://[^\s<>()\]"]+""")
        .findAll(text)
        .map { it.value.trimEnd('.', ',', ';') }
        .distinct()
        .take(4)
        .toList()

internal fun turnStatusLabel(turn: LinkTurn): String = when {
    turn.playbackPhase == PlaybackPhase.PLAYING -> "PLAYING"
    turn.playbackPhase == PlaybackPhase.PAUSED -> "PAUSED"
    turn.deliveryPhase == DeliveryPhase.FAILED -> "SEND FAILED"
    turn.replyPhase == ReplyPhase.FAILED -> "REPLY FAILED"
    turn.replyPhase == ReplyPhase.READY -> "REPLY READY"
    turn.replyPhase == ReplyPhase.THINKING -> "THINKING"
    turn.deliveryPhase == DeliveryPhase.QUEUED -> "SENT"
    else -> "SENDING"
}

internal fun phoneActivePreviewState(playbackActive: Boolean): LinkState = LinkState(
    connection = ConnectionState.CONNECTED,
    connectionDetail = "PRIVATE RELAY READY",
    connectionObservedAtMs = System.currentTimeMillis(),
    targets = listOf(
        LinkTarget(id = "skyvw:3", label = "SKYVW 3"),
        LinkTarget(id = "skyvw:9", label = "SKYVW 9"),
    ),
    selectedTargetId = "skyvw:3",
    turns = listOf(
        LinkTurn(
            turnId = "qa-turn",
            targetId = "skyvw:3",
            targetLabel = "SKYVW 3",
            userText = "Voice transcript: polish the shared Link experience.",
            replyText = "The phone and watch now keep conversation primary and setup secondary.",
            respondingTarget = "SKYVW 3",
            createdAtMs = System.currentTimeMillis() - 12_000,
            deliveryPhase = DeliveryPhase.QUEUED,
            replyPhase = ReplyPhase.READY,
            playbackPhase = if (playbackActive) PlaybackPhase.PLAYING else PlaybackPhase.STOPPED,
            playbackPositionMs = if (playbackActive) 31_000L else 0L,
            playbackDurationMs = if (playbackActive) 74_000L else 0L,
        ),
    ),
    activePlaybackTurnId = "qa-turn".takeIf { playbackActive },
    update = UpdatePresentation(
        currentVersion = "1.0.0",
        state = "up-to-date",
        detail = "UP TO DATE",
    ),
)
