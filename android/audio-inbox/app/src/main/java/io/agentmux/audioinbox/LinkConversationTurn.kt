package io.agentmux.audioinbox

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.adelost.designkit.ui.RingIcons
import com.adelost.ringkit.ui.RingMessage
import com.adelost.ringkit.ui.RingMessageSpec
import com.adelost.ringkit.ui.RingPlaybackControls
import com.adelost.ringkit.ui.RingPlaybackSpec
import com.adelost.ringkit.ui.RingPlaybackState
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackOperation
import io.agentmux.linkcore.PlaybackPhase

@Composable
internal fun ConversationTurn(turn: LinkTurn, showPlayer: Boolean, onPlayback: (PlaybackOperation) -> Unit) {
    val context = LocalContext.current
    Column(Modifier.padding(horizontal = 24.dp)) {
        RingMessage(RingMessageSpec("YOU", turn.userText.ifBlank { "Voice message" }, turnStatusLabel(turn)))
        if (turn.replyText.isNotBlank()) {
            RingMessage(RingMessageSpec(turn.respondingTarget.ifBlank { turn.targetId }, turn.replyText))
            if (showPlayer) {
                LinkPlaybackControls(
                    turn, { onPlayback(PlaybackOperation.PLAY) },
                    { onPlayback(PlaybackOperation.PAUSE) },
                    { onPlayback(PlaybackOperation.RESUME) },
                    { onPlayback(PlaybackOperation.STOP) },
                )
            } else {
                PhoneRow("READ ALOUD", "", RingIcons.Speaker, immediate = true,
                    onTap = { onPlayback(PlaybackOperation.PLAY) })
            }
            attachmentUrls(turn.replyText).forEach { url ->
                PhoneRow("OPEN LINK", Uri.parse(url).host.orEmpty(), RingIcons.Link, immediate = true,
                    onTap = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } })
            }
        }
        listOf(turn.deliveryError, turn.replyError, turn.playbackError)
            .filter(String::isNotBlank)
            .forEach { PhoneRow("COULDN'T COMPLETE", it, RingIcons.Warning) }
    }
}

@Composable
internal fun LinkPlaybackControls(
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
