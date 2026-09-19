package io.agentmux.audioinbox

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import io.agentmux.linkui.product.wakePhaseGlyph
import io.agentmux.linkui.product.WakePhaseGlyph
import io.agentmux.wakeword.WakePhase
import io.agentmux.wakeword.WakePhrase
import io.agentmux.wakeword.WakeStatus

internal const val WAKE_NOTIFICATION_ID = 4_107
private const val WAKE_CHANNEL = "wake-word"

/** The ongoing notification that says what hands-free Link is doing and offers to turn it off. */
internal object WakeNotifications {
    fun build(context: Context, status: WakeStatus): Notification {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            // An ongoing notification for a microphone that is only waiting has nothing to announce:
            // no sound, no vibration, no badge. Android keeps a channel's settings once it exists, so
            // this decides how it starts life on a fresh install.
            NotificationChannel(WAKE_CHANNEL, "Wake word", NotificationManager.IMPORTANCE_LOW).apply {
                setSound(null, null)
                enableVibration(false)
                setShowBadge(false)
            },
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
            .setSmallIcon(wakeGlyphDrawable(status.phase))
            .setContentTitle(wakePhaseTitle(status.phase, status.phrase))
            .setContentText(status.detail.ifBlank { wakeHint(status.phrase) })
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Turn off", stop).build())
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
    WakePhase.BLOCKED -> "Wake word stopped"
}

/**
 * Link's own glyph rather than the system's "speak now" microphone, which Mattias read as Link hearing
 * him all the time. Which of the three the phase wears is declared, not decided here; this only says
 * which drawable each declared glyph is, because a resource id is the one thing a declaration cannot hold.
 * Both surfaces that wear a glyph read it here, so the status bar and the main page's row cannot differ.
 */
internal fun wakeGlyphDrawable(phase: WakePhase): Int = when (wakePhaseGlyph(phase)) {
    WakePhaseGlyph.WAITING -> R.drawable.ic_wake_waiting
    WakePhaseGlyph.HEARING -> R.drawable.ic_wake_hearing
    WakePhaseGlyph.SPEAKING -> R.drawable.ic_wake_speaking
    WakePhaseGlyph.ATTENTION -> R.drawable.ic_wake_attention
}

internal fun wakeHint(phrase: WakePhrase): String = "Say \"${phrase.spoken}\", then your question"
