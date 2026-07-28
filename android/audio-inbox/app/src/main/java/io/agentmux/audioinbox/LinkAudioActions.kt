package io.agentmux.audioinbox

import android.app.Activity
import android.content.Intent
import android.os.Build
import io.agentmux.linkcore.LinkTurn

/** Starts and controls reply playback through the Link foreground service. */
internal class LinkAudioActions(
    private val activity: Activity,
    private val targetForId: (String) -> ConversationTarget?,
) {
    fun playReply(turn: LinkTurn, explicitReplay: Boolean) {
        val target = targetForId(turn.targetId) ?: return
        if (turn.replyText.isBlank()) return
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
