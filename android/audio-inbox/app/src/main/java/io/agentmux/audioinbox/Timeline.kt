package io.agentmux.audioinbox

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.ReplyPhase

@Composable
internal fun ConversationTimeline(
    turns: List<LinkTurn>,
    onPlay: (String) -> Unit,
    onPause: () -> Unit,
    onStop: () -> Unit,
) {
    if (turns.isEmpty()) {
        Text("No conversation yet", color = LinkTokens.Muted)
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        turns.takeLast(30).forEach { turn ->
            TurnCard(turn, onPlay, onPause, onStop)
        }
    }
}

@Composable
private fun TurnCard(
    turn: LinkTurn,
    onPlay: (String) -> Unit,
    onPause: () -> Unit,
    onStop: () -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = LinkTokens.SurfaceStrong,
        border = BorderStroke(1.dp, LinkTokens.Border),
    ) {
        Column(
            verticalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.fillMaxWidth().padding(12.dp),
        ) {
            Row(
                horizontalArrangement = Arrangement.SpaceBetween,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("You → ${turn.targetLabel}", fontWeight = FontWeight.SemiBold)
                Text(turn.statusLabel(), color = statusColor(turn))
            }
            if (turn.userText.isNotBlank()) Text(turn.userText, color = LinkTokens.Ink)
            if (turn.replyText.isNotBlank()) {
                Text(
                    text = "Reply · ${turn.respondingTarget.ifBlank { turn.targetId }}",
                    color = LinkTokens.Accent,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(turn.replyText, color = LinkTokens.Ink)
                Attachments(turn.replyText)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    when (turn.playbackPhase) {
                        PlaybackPhase.PLAYING -> {
                            SmallAction("Pause", onPause)
                            SmallAction("Stop", onStop)
                        }
                        PlaybackPhase.PAUSED -> {
                            SmallAction("Play", { onPlay(turn.turnId) })
                            SmallAction("Stop", onStop)
                        }
                        PlaybackPhase.STOPPED, PlaybackPhase.PLAYED,
                        PlaybackPhase.SKIPPED, PlaybackPhase.FAILED ->
                            SmallAction("Replay", { onPlay(turn.turnId) })
                        PlaybackPhase.IDLE, PlaybackPhase.QUEUED -> {
                            if (turn.replyPhase == ReplyPhase.READY) {
                                SmallAction("Play", { onPlay(turn.turnId) })
                            }
                        }
                    }
                }
            }
            listOf(turn.deliveryError, turn.replyError, turn.playbackError)
                .filter(String::isNotBlank)
                .forEach { Text(it, color = LinkTokens.Error) }
        }
    }
}

@Composable
private fun SmallAction(label: String, action: () -> Unit) {
    OutlinedButton(onClick = action) {
        Text(label)
    }
}

@Composable
private fun Attachments(text: String) {
    val context = LocalContext.current
    val urls = rememberAttachmentUrls(text)
    if (urls.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        urls.forEach { url ->
            Text(
                text = if (url.matches(Regex("(?i).+\\.(png|jpe?g|webp)(\\?.*)?$"))) {
                    "Image attachment · $url"
                } else {
                    "Attachment · $url"
                },
                color = LinkTokens.Accent,
                modifier = Modifier.clickable {
                    runCatching {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    }
                },
            )
        }
    }
}

private fun rememberAttachmentUrls(text: String): List<String> =
    Regex("""https?://[^\s<>()\]"]+""")
        .findAll(text)
        .map { it.value.trimEnd('.', ',', ';') }
        .distinct()
        .take(4)
        .toList()

private fun LinkTurn.statusLabel(): String = when {
    playbackPhase == PlaybackPhase.PLAYING -> "playing"
    playbackPhase == PlaybackPhase.PAUSED -> "paused"
    playbackPhase == PlaybackPhase.STOPPED -> "reply ready · stopped"
    playbackPhase == PlaybackPhase.PLAYED -> "reply ready · played"
    playbackPhase == PlaybackPhase.SKIPPED -> "reply ready · skipped"
    playbackPhase == PlaybackPhase.FAILED -> "reply ready · audio failed"
    deliveryPhase == DeliveryPhase.FAILED -> "send failed"
    replyPhase == ReplyPhase.FAILED -> "reply failed"
    replyPhase == ReplyPhase.READY -> "reply ready"
    replyPhase == ReplyPhase.THINKING -> "thinking"
    deliveryPhase == DeliveryPhase.QUEUED -> "sent / queued"
    else -> "sending"
}

private fun statusColor(turn: LinkTurn) = when {
    turn.deliveryPhase == DeliveryPhase.FAILED ||
        turn.replyPhase == ReplyPhase.FAILED ||
        turn.playbackPhase == PlaybackPhase.FAILED -> LinkTokens.Error
    turn.deliveryPhase == DeliveryPhase.SENDING ||
        turn.replyPhase == ReplyPhase.THINKING -> LinkTokens.Warning
    else -> LinkTokens.Accent
}
