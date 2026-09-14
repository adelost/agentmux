package io.agentmux.audioinbox

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import io.agentmux.wakeword.WakePhase
import io.agentmux.wakeword.WakePhrase
import io.agentmux.wakeword.WakeStatus

internal const val WAKE_NOTIFICATION_ID = 4_107
private const val WAKE_CHANNEL = "wake-word"

/** The ongoing notification that says what hands-free Link is doing and offers Stop. */
internal object WakeNotifications {
    fun build(context: Context, status: WakeStatus): Notification {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(WAKE_CHANNEL, "Wake word", NotificationManager.IMPORTANCE_LOW),
        )
        val open = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            context, 1,
            Intent(context, WakeWordService::class.java).setAction(WakeWordService.ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(context, WAKE_CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(wakePhaseTitle(status.phase, status.phrase))
            .setContentText(status.detail.ifBlank { wakeHint(status.phrase) })
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }

    fun update(context: Context, status: WakeStatus) {
        context.getSystemService(NotificationManager::class.java).notify(WAKE_NOTIFICATION_ID, build(context, status))
    }
}

internal fun wakePhaseTitle(phase: WakePhase, phrase: WakePhrase): String = when (phase) {
    WakePhase.OFF -> "Wake word off"
    WakePhase.LISTENING -> "Listening for \"${phrase.spoken}\""
    WakePhase.CAPTURING -> "Listening to your question"
    WakePhase.SENDING -> "Sending your question"
    WakePhase.THINKING -> "Waiting for the reply"
    WakePhase.SPEAKING -> "Reading the reply"
    WakePhase.FOLLOW_UP -> "Ask a follow-up"
    WakePhase.BLOCKED -> "Wake word stopped"
}

internal fun wakeHint(phrase: WakePhrase): String = "Say \"${phrase.spoken}\", then your question"
