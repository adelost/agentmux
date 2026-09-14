package io.agentmux.audioinbox

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.LinkAction
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkui.readAloudText

/** Starts and controls reply playback through the Link foreground service. */
internal class LinkAudioActions(
    private val context: Context,
    private val targetForId: (String) -> ConversationTarget?,
) {
    fun playReply(turn: LinkTurn, explicitReplay: Boolean): String? {
        val target = targetForId(turn.targetId) ?: return "Recipient is unavailable."
        val text = turn.readAloudText()
        if (text.isBlank()) return "No reply to read."
        if (text.length > AppContract.MAX_REPLY_AUDIO_CHARACTERS) {
            return "This reply is too long for audio. The full text is above."
        }
        val intent = Intent(context, AudioInboxService::class.java).apply {
            action = if (explicitReplay) AppContract.ACTION_REPLAY_REPLY
            else AppContract.ACTION_PLAY_REPLY
            putExtra(AppContract.EXTRA_TURN_ID, turn.turnId)
            putExtra(AppContract.EXTRA_TEXT, text)
            putExtra(AppContract.EXTRA_SERVER, target.serverUrl)
            putExtra(
                AppContract.EXTRA_TARGET_LABEL,
                turn.respondingTarget.ifBlank { target.id },
            )
        }
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
        else context.startService(intent)
        return null
    }

    fun pause() = send(AppContract.ACTION_PAUSE_AUDIO)

    fun resume() = send(AppContract.ACTION_RESUME_AUDIO)

    fun stop() = send(AppContract.ACTION_STOP_AUDIO)

    private fun send(actionName: String) {
        context.startService(Intent(context, AudioInboxService::class.java).apply {
            action = actionName
        })
    }
}

/** Decode the service receipt at the existing persistence boundary. */
internal fun SharedPreferences.playbackAction(key: String): LinkAction? {
    val phase = runCatching { PlaybackPhase.valueOf(getString(key, "").orEmpty().uppercase()) }
        .getOrNull() ?: return null
    val turnId = key.substringAfter("turn-playback:")
    val reason = getString("turn-playback-detail:$turnId", "").orEmpty()
    return if (phase == PlaybackPhase.FAILED && reason.isNotBlank()) LinkAction.PlaybackFailed(turnId, reason)
    else LinkAction.Playback(turnId, phase)
}
