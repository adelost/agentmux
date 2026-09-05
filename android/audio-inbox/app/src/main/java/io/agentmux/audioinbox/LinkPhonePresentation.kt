package io.agentmux.audioinbox

import com.adelost.releasekit.UpdateState
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.ReplyPhase
import java.time.Instant
import kotlin.math.sin

internal fun attachmentUrls(text: String): List<String> =
    Regex("""https?://[^\s<>()\]"]+""")
        .findAll(text)
        .map { it.value.trimEnd('.', ',', ';') }
        .distinct()
        .take(4)
        .toList()

internal fun turnStatusLabel(turn: LinkTurn): String = when {
    turn.playbackPhase == PlaybackPhase.PLAYING -> "Reading aloud"
    turn.playbackPhase == PlaybackPhase.PAUSED -> "Paused"
    turn.deliveryPhase == DeliveryPhase.FAILED -> "Not sent"
    turn.replyPhase == ReplyPhase.FAILED -> "Couldn't get a reply"
    turn.replyPhase == ReplyPhase.READY -> "Replied"
    turn.replyPhase == ReplyPhase.THINKING -> "Thinking…"
    turn.deliveryPhase == DeliveryPhase.QUEUED -> "Sent"
    else -> "Sending…"
}

internal fun phoneActivePreviewState(playbackActive: Boolean): LinkState = LinkState(
    connection = ConnectionState.CONNECTED,
    connectionDetail = "PRIVATE RELAY READY",
    connectionObservedAtMs = System.currentTimeMillis(),
    targets = listOf(
        LinkTarget(id = "demo:1", label = "Implementation worker · available for your next task"),
        LinkTarget(id = "demo:2", label = "Kimi K3 · a second agent with a deliberately long description"),
    ),
    selectedTargetId = "demo:1",
    turns = listOf(
        LinkTurn(
            turnId = "qa-turn",
            targetId = "demo:1",
            targetLabel = "DEMO ONE",
            userText = "Voice transcript: polish the shared Link experience.",
            replyText = "The phone and watch now keep conversation primary and setup secondary.",
            respondingTarget = "DEMO ONE",
            createdAtMs = System.currentTimeMillis() - 12_000,
            deliveryPhase = DeliveryPhase.QUEUED,
            replyPhase = ReplyPhase.READY,
            playbackPhase = if (playbackActive) PlaybackPhase.PLAYING else PlaybackPhase.STOPPED,
            playbackPositionMs = if (playbackActive) 31_000L else 0L,
            playbackDurationMs = if (playbackActive) 74_000L else 0L,
        ),
    ),
    activePlaybackTurnId = "qa-turn".takeIf { playbackActive },
)

/** The fixed settings-page update preview the qa_state/qa_page extras have always shown. */
internal fun phoneQaUpdateState(): UpdateState = UpdateState.Available(
    versionName = "1.2.2",
    sizeBytes = 6_400_000L,
    changelog = "Shared update information across Phone and Wear.",
    publishedAtEpochMillis = Instant.parse("2026-08-02T05:33:20Z").toEpochMilli(),
)

/** The synthetic waveform level the QA preview feeds the capture control. */
internal fun qaRecordedLevel(): Float {
    val phase = System.currentTimeMillis() / 85.0
    return (0.16 + 0.78 * kotlin.math.abs(sin(phase))).toFloat()
}
