package io.agentmux.linkui

import com.adelost.designkit.ui.CircleActionTiming
import com.adelost.designkit.ui.RingIcons
import com.adelost.ringkit.ui.RowSpec
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackOperation
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.ReplyPhase
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/** Both hosts select the same retained conversation by stable recipient ID. */
fun linkConversationTurns(turns: List<LinkTurn>, recipientId: String?): List<LinkTurn> =
    if (recipientId == null) emptyList() else turns.filter { it.targetId == recipientId }

fun linkHistoryRows(
    turns: List<LinkTurn>,
    onOpen: (String) -> Unit,
    zoneId: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault(),
): List<RowSpec> {
    if (turns.isEmpty()) return listOf(RowSpec("empty", "NO MESSAGES YET", "", icon = null))
    val format = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT).withLocale(locale).withZone(zoneId)
    return turns.asReversed().map { turn ->
        val text = turn.userText.ifBlank { "Voice message" }.replace(Regex("\\s+"), " ")
        RowSpec(
            key = turn.turnId,
            title = if (text.length > 64) text.take(64) + "…" else text,
            sub = "${format.format(Instant.ofEpochMilli(turn.createdAtMs))} · ${turnStatusLabel(turn)}",
            icon = RingIcons.Pencil,
            onTap = { onOpen(turn.turnId) },
            actionTiming = CircleActionTiming.IMMEDIATE,
            multiline = true,
        )
    }
}

/** Native Wear TTS has Play/Stop only. These same rows serve home and any old reply. */
fun linkReadAloudRow(turn: LinkTurn, onCommand: (PlaybackOperation, String) -> Unit): RowSpec? {
    if (turn.replyText.isBlank()) return null
    val active = turn.playbackPhase in setOf(PlaybackPhase.QUEUED, PlaybackPhase.PLAYING)
    val operation = if (active) PlaybackOperation.STOP else PlaybackOperation.PLAY
    return RowSpec(
        key = "playback",
        title = when {
            active -> "STOP"
            turn.playbackPhase == PlaybackPhase.FAILED -> "TRY AGAIN"
            else -> "PLAY"
        },
        sub = when (turn.playbackPhase) {
            PlaybackPhase.PLAYING -> "Reading aloud"
            PlaybackPhase.QUEUED -> "Preparing audio…"
            PlaybackPhase.FAILED -> turn.playbackError.ifBlank { "Audio unavailable" }
            else -> ""
        },
        icon = if (active) RingIcons.Stop else RingIcons.Play,
        onTap = { onCommand(operation, turn.turnId) },
        actionTiming = CircleActionTiming.IMMEDIATE,
        multiline = true,
    )
}

fun turnStatusLabel(turn: LinkTurn): String = when {
    turn.playbackPhase == PlaybackPhase.PLAYING -> "Reading aloud"
    turn.playbackPhase == PlaybackPhase.PAUSED -> "Paused"
    turn.deliveryPhase == DeliveryPhase.FAILED -> "Not sent"
    turn.replyPhase == ReplyPhase.FAILED -> "Couldn't get a reply"
    turn.replyPhase == ReplyPhase.READY -> "Replied"
    turn.replyPhase == ReplyPhase.THINKING -> "Thinking…"
    turn.deliveryPhase == DeliveryPhase.QUEUED -> "Sent"
    else -> "Sending…"
}

fun attachmentUrls(text: String): List<String> =
    Regex("""https?://[^\s<>()\]"]+""")
        .findAll(text)
        .map { it.value.trimEnd('.', ',', ';') }
        .distinct()
        .take(4)
        .toList()
