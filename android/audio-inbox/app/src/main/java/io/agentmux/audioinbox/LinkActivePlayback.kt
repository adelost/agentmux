package io.agentmux.audioinbox

import androidx.compose.runtime.Composable
import io.agentmux.linkcore.PlaybackOperation
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkui.product.LinkPlaybackCommandEvent
import io.agentmux.linkui.product.LinkPlaybackPresentation

/** One anchored player: it remains reachable even when reading another thread. */
@Composable
internal fun LinkActivePlayback(graph: PhoneLinkProductGraph, playback: LinkPlaybackPresentation) {
    val turn = playback.turn ?: return
    if (turn.playbackPhase !in setOf(PlaybackPhase.QUEUED, PlaybackPhase.PLAYING, PlaybackPhase.PAUSED)) return
    fun command(operation: PlaybackOperation) =
        graph.onActivePlaybackCommand(LinkPlaybackCommandEvent(operation, turn.turnId))
    LinkPlaybackControls(turn, { command(PlaybackOperation.PLAY) },
        { command(PlaybackOperation.PAUSE) }, { command(PlaybackOperation.RESUME) },
        { command(PlaybackOperation.STOP) })
}
