package io.agentmux.audioinbox;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;

/** Foreground notification shell; Media3 owns the playback notification. */
final class AudioServiceNotifier {
    private static final String CHANNEL = "agent-audio-inbox-status";
    private static final int ID = 7301;
    private final AudioInboxService service;

    AudioServiceNotifier(AudioInboxService service) {
        this.service = service;
        NotificationManager manager = service.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(
            CHANNEL,
            "Hands-free connection",
            NotificationManager.IMPORTANCE_LOW
        ));
    }

    void start() {
        PendingIntent open = PendingIntent.getActivity(
            service,
            0,
            new Intent(service, MainActivity.class),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        Notification notification = new Notification.Builder(service, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_lock_silent_mode_off)
            .setContentTitle("Agentmux Link")
            .setContentText("Audio controls are ready")
            .setContentIntent(open)
            .setOngoing(true)
            .build();
        if (Build.VERSION.SDK_INT >= 29) {
            service.startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            service.startForeground(ID, notification);
        }
    }
}
