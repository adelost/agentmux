package io.agentmux.audioinbox

import android.app.Activity
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.LinkAction
import io.agentmux.linkcore.PlaybackPhase

/** Starts and controls reply playback through the Link foreground service. */
internal class LinkAudioActions(
    private val activity: Activity,
    private val targetForId: (String) -> ConversationTarget?,
) {
    fun playReply(turn: LinkTurn, explicitReplay: Boolean): String? {
        val target = targetForId(turn.targetId) ?: return "Recipient is unavailable."
        if (turn.replyText.isBlank()) return "No reply to read."
        if (turn.replyText.length > AppContract.MAX_REPLY_AUDIO_CHARACTERS) {
            return "This reply is too long for audio. The full text is above."
        }
        val intent = Intent(activity, AudioInboxService::class.java).apply {
            action = if (explicitReplay) AppContract.ACTION_REPLAY_REPLY
            else AppContract.ACTION_PLAY_REPLY
            putExtra(AppContract.EXTRA_TURN_ID, turn.turnId)
            putExtra(AppContract.EXTRA_TEXT, turn.replyText)
            putExtra(AppContract.EXTRA_SERVER, target.serverUrl)
            putExtra(
                AppContract.EXTRA_TARGET_LABEL,
                turn.respondingTarget.ifBlank { target.id },
            )
        }
        if (Build.VERSION.SDK_INT >= 26) activity.startForegroundService(intent)
        else activity.startService(intent)
        return null
    }

    fun pause() = send(AppContract.ACTION_PAUSE_AUDIO)

    fun resume() = send(AppContract.ACTION_RESUME_AUDIO)

    fun stop() = send(AppContract.ACTION_STOP_AUDIO)

    private fun send(actionName: String) {
        activity.startService(Intent(activity, AudioInboxService::class.java).apply {
            action = actionName
        })
    }
}

/** Decode the service receipt at the existing persistence boundary. */
internal fun SharedPreferences.playbackAction(key: String): LinkAction.Playback? {
    val phase = runCatching { PlaybackPhase.valueOf(getString(key, "").orEmpty().uppercase()) }
        .getOrNull() ?: return null
    return LinkAction.Playback(key.substringAfter("turn-playback:"), phase)
}
