package io.agentmux.linkui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.adelost.designkit.ui.RingIcons
import com.adelost.designkit.ui.CircleActionTiming
import com.adelost.ringkit.ui.RingRow
import com.adelost.ringkit.ui.RingMessage
import com.adelost.ringkit.ui.RingMessageSpec
import com.adelost.ringkit.ui.RingPlaybackControls
import com.adelost.ringkit.ui.RingPlaybackSpec
import com.adelost.ringkit.ui.RingPlaybackState
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackOperation
import io.agentmux.linkcore.PlaybackPhase

@Composable
fun LinkConversationTurn(
    turn: LinkTurn,
    onPlayback: (PlaybackOperation) -> Unit,
    modifier: Modifier = Modifier,
    showPlayAction: Boolean = true,
    openLinks: Boolean = true,
) {
    val context = LocalContext.current
    Column(modifier) {
        RingMessage(RingMessageSpec("YOU", turn.userText.ifBlank { "Voice message" }, turnStatusLabel(turn)))
        if (turn.replyText.isNotBlank()) {
            RingMessage(RingMessageSpec(turn.respondingTarget.ifBlank { turn.targetId }, turn.replyText))
            if (showPlayAction && turn.playbackPhase !in setOf(PlaybackPhase.QUEUED, PlaybackPhase.PLAYING, PlaybackPhase.PAUSED)) {
                RingRow("READ ALOUD", if (turn.playbackPhase == PlaybackPhase.FAILED && turn.playbackError.isBlank())
                    "Audio unavailable · tap to retry" else "", icon = RingIcons.Speaker,
                    actionTiming = CircleActionTiming.IMMEDIATE,
                    onTap = { onPlayback(PlaybackOperation.PLAY) })
            }
            if (openLinks) attachmentUrls(turn.replyText).forEach { url ->
                RingRow("OPEN LINK", Uri.parse(url).host.orEmpty(), icon = RingIcons.Link,
                    actionTiming = CircleActionTiming.IMMEDIATE,
                    onTap = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } })
            }
        }
        listOf(turn.deliveryError, turn.replyError, turn.playbackError)
            .filter(String::isNotBlank)
            .forEach { RingRow("", it, onTap = null, icon = RingIcons.Warning) }
    }
}

@Composable
fun LinkPlaybackControls(
    turn: LinkTurn,
    onPlay: (String) -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onStop: () -> Unit,
) = RingPlaybackControls(
    spec = RingPlaybackSpec(
        title = turn.targetId,
        state = when (turn.playbackPhase) {
            PlaybackPhase.QUEUED -> RingPlaybackState.LOADING
            PlaybackPhase.PLAYING -> RingPlaybackState.PLAYING
            PlaybackPhase.PAUSED -> RingPlaybackState.PAUSED
            PlaybackPhase.PLAYED -> RingPlaybackState.COMPLETE
            PlaybackPhase.FAILED -> RingPlaybackState.FAILED
            else -> RingPlaybackState.READY
        },
        positionMs = turn.playbackPositionMs,
        durationMs = turn.playbackDurationMs,
        onPlayPause = when (turn.playbackPhase) {
            PlaybackPhase.PLAYING -> onPause
            PlaybackPhase.PAUSED -> onResume
            else -> ({ onPlay(turn.turnId) })
        },
        onStop = onStop,
    ),
)
