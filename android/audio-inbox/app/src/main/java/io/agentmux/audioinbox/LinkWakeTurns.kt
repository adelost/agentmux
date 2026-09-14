package io.agentmux.audioinbox

import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.ReplyPhase
import io.agentmux.wakeword.TurnProgress
import io.agentmux.wakeword.TurnStage

/** Link's delivery, reply and playback axes folded into the generic hands-free turn stages. */
internal fun LinkTurn?.wakeProgress(): TurnProgress = when {
    this == null -> TurnProgress(TurnStage.GONE)
    deliveryPhase == DeliveryPhase.FAILED -> TurnProgress(TurnStage.SEND_FAILED, deliveryError)
    replyPhase == ReplyPhase.FAILED -> TurnProgress(TurnStage.REPLY_FAILED, replyError)
    replyPhase == ReplyPhase.READY -> when (playbackPhase) {
        PlaybackPhase.IDLE -> TurnProgress(TurnStage.THINKING)
        PlaybackPhase.QUEUED, PlaybackPhase.PLAYING, PlaybackPhase.PAUSED -> TurnProgress(TurnStage.SPEAKING)
        PlaybackPhase.PLAYED, PlaybackPhase.STOPPED, PlaybackPhase.SKIPPED -> TurnProgress(TurnStage.SPOKEN)
        PlaybackPhase.FAILED -> TurnProgress(TurnStage.SPEAK_FAILED, playbackError)
    }
    deliveryPhase == DeliveryPhase.SENDING -> TurnProgress(TurnStage.SENDING)
    else -> TurnProgress(TurnStage.THINKING)
}

/** A ready reply nobody has started reading yet; the wake loop asks for it once. */
internal fun LinkTurn.awaitsReadAloud(): Boolean =
    replyPhase == ReplyPhase.READY && playbackPhase == PlaybackPhase.IDLE && replyText.isNotBlank()
