package io.agentmux.audioinbox

import io.agentmux.linkui.withHistoryPreview

import com.adelost.releasekit.UpdateState
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkcore.LinkTargetModel
import io.agentmux.linkcore.LinkTargetModelStatus
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.ReplyPhase
import java.time.Instant
import kotlin.math.sin

internal fun phoneActivePreviewState(playbackActive: Boolean, scenario: String? = null): LinkState = LinkState(
    connection = ConnectionState.CONNECTED,
    connectionDetail = "PRIVATE RELAY READY",
    connectionObservedAtMs = System.currentTimeMillis(),
    targets = listOf(
        LinkTarget(
            id = "demo:1",
            label = "Astra orchestrator · internal synthetic description",
            model = LinkTargetModel(
                status = LinkTargetModelStatus.CURRENT,
                observedModel = "gpt-5.6-sol",
                observedEffort = "xhigh",
                configuredModel = "gpt-5.6-sol",
                configuredEffort = "xhigh",
            ),
        ),
        LinkTarget(
            id = "demo:2",
            label = "Previous worker · internal synthetic description",
            model = LinkTargetModel(
                status = LinkTargetModelStatus.STALE,
                observedModel = "claude-fable-5",
                configuredModel = "gpt-5.6-sol",
                configuredEffort = "xhigh",
            ),
        ),
        LinkTarget(
            id = "ops:0",
            label = "Self-directed fleet · internal synthetic description",
            model = LinkTargetModel(
                status = LinkTargetModelStatus.UNKNOWN,
                configuredModel = "gpt-6-astra",
                configuredEffort = "max",
            ),
        ),
        LinkTarget(
            id = "ops:1",
            label = "PAUSED on PR · internal synthetic description",
            available = false,
            acceptsMessages = true,
            model = LinkTargetModel(
                status = LinkTargetModelStatus.CURRENT,
                observedModel = "gpt-reserve",
                observedEffort = "xhigh",
            ),
        ),
        LinkTarget(id = "windows", label = "Windows rescue · internal synthetic description"),
    ),
    selectedTargetId = "demo:1",
    turns = listOf(
        LinkTurn(
            turnId = "qa-turn",
            targetId = "demo:1",
            targetLabel = "DEMO ONE",
            userText = "Voice transcript: polish the shared Link experience.",
            replyText = "The phone and watch now keep conversation primary and setup secondary.",
            respondingTarget = "demo:1",
            createdAtMs = System.currentTimeMillis() - 12_000,
            deliveryPhase = DeliveryPhase.QUEUED,
            replyPhase = ReplyPhase.READY,
            playbackPhase = if (playbackActive) PlaybackPhase.PLAYING else PlaybackPhase.STOPPED,
            playbackPositionMs = if (playbackActive) 31_000L else 0L,
            playbackDurationMs = if (playbackActive) 74_000L else 0L,
        ),
    ),
    activePlaybackTurnId = "qa-turn".takeIf { playbackActive },
).let { state ->
    when (scenario) {
        null -> state
        "history" -> state.withHistoryPreview()
        "offline" -> state.copy(connection = ConnectionState.DISCONNECTED, targets = emptyList(),
            selectedTargetId = "", turns = emptyList())
        "waiting" -> state.copy(turns = state.turns.map { it.copy(replyText = "", replyPhase = ReplyPhase.THINKING) })
        "error" -> state.copy(turns = state.turns.map { it.copy(replyText = "",
            deliveryPhase = DeliveryPhase.FAILED, deliveryError = "No connection. Message not sent.") })
        "loading" -> state.copy(activePlaybackTurnId = "qa-turn",
            turns = state.turns.map { it.copy(playbackPhase = PlaybackPhase.QUEUED) })
        "long-reply" -> state.copy(turns = state.turns.map { turn ->
            turn.copy(
                userText = "SYNTHETIC QA · Show the complete long answer.",
                replyText = buildString {
                    append("SYNTHETIC QA · This answer stays fully visible and selectable. ")
                    repeat(18) { index ->
                        append("Paragraph ${index + 1} checks readable wrapping at larger system text without clipping. ")
                    }
                },
            )
        })
        else -> error("Unknown Link preview scenario: $scenario")
    }
}

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
