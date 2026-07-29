package io.agentmux.audioinbox;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;

import androidx.media3.common.Player;
import androidx.media3.session.MediaSession;

/** Foreground and lock-screen media controls for the long-lived audio service. */
final class AudioServiceNotifier {
    private static final String CHANNEL = "agent-audio-inbox-status";
    private static final int ID = 7301;
    private final AudioInboxService service;
    private MediaSession session;
    private Player player;

    AudioServiceNotifier(AudioInboxService service) {
        this.service = service;
        NotificationManager manager = service.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(
            CHANNEL,
            "Hands-free connection",
            NotificationManager.IMPORTANCE_LOW
        ));
    }

    void attach(MediaSession session, Player player) {
        this.session = session;
        this.player = player;
        player.addListener(new Player.Listener() {
            @Override
            public void onEvents(Player ignored, Player.Events events) {
                if (events.containsAny(
                    Player.EVENT_MEDIA_ITEM_TRANSITION,
                    Player.EVENT_PLAY_WHEN_READY_CHANGED,
                    Player.EVENT_PLAYBACK_STATE_CHANGED
                )) {
                    start();
                }
            }
        });
    }

    void start() {
        PendingIntent open = PendingIntent.getActivity(
            service,
            0,
            new Intent(service, MainActivity.class),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        Notification.Builder builder = new Notification.Builder(service, CHANNEL)
            .setSmallIcon(R.drawable.ic_link_notification)
            .setContentTitle("Agentmux Link")
            .setContentIntent(open)
            .setOngoing(true);
        if (session != null && player != null && player.getCurrentMediaItem() != null) {
            boolean playing = player.isPlaying();
            builder
                .setContentText(playing ? "Speaking · Stop anytime" : "Paused")
                .addAction(action(
                    android.R.drawable.ic_media_rew,
                    "Replay",
                    AudioInboxService.ACTION_REPLAY,
                    1
                ))
                .addAction(action(
                    playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                    playing ? "Pause" : "Play",
                    playing
                        ? AppContract.ACTION_PAUSE_AUDIO
                        : AppContract.ACTION_RESUME_AUDIO,
                    2
                ))
                .addAction(action(
                    android.R.drawable.ic_menu_close_clear_cancel,
                    "Stop",
                    AppContract.ACTION_STOP_AUDIO,
                    3
                ))
                .setStyle(new Notification.MediaStyle()
                    .setMediaSession(session.getPlatformToken())
                    .setShowActionsInCompactView(0, 1, 2));
        } else {
            builder.setContentText("Audio controls are ready");
        }
        Notification notification = builder.build();
        if (Build.VERSION.SDK_INT >= 29) {
            service.startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            service.startForeground(ID, notification);
        }
    }

    private Notification.Action action(int icon, String label, String action, int requestCode) {
        PendingIntent command = PendingIntent.getService(
            service,
            requestCode,
            new Intent(service, AudioInboxService.class).setAction(action),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        return new Notification.Action.Builder(icon, label, command).build();
    }
}
