package io.agentmux.audioinbox;

import android.os.Handler;

import androidx.media3.common.C;
import androidx.media3.common.Player;

final class PlaybackProgressPublisher implements Runnable {
    static final long INTERVAL_MS = 250L;

    private final Handler handler;
    private final Player player;
    private final AudioEventClaims claims;
    private final PlaybackQueue playbackQueue;

    PlaybackProgressPublisher(
        Handler handler,
        Player player,
        AudioEventClaims claims,
        PlaybackQueue playbackQueue
    ) {
        this.handler = handler;
        this.player = player;
        this.claims = claims;
        this.playbackQueue = playbackQueue;
    }

    static PlaybackProgressPublisher start(
        Handler handler,
        Player player,
        AudioEventClaims claims,
        PlaybackQueue playbackQueue
    ) {
        PlaybackProgressPublisher publisher =
            new PlaybackProgressPublisher(handler, player, claims, playbackQueue);
        publisher.start();
        return publisher;
    }

    void start() {
        handler.post(this);
    }

    void stop() {
        handler.removeCallbacks(this);
    }

    @Override
    public void run() {
        AudioEventClaims.Entry item = claims.queued(playbackQueue.active());
        if (item != null && item.direct && item.turnId != null && !item.turnId.isBlank()) {
            long duration = player.getDuration();
            PlaybackProgressBus.publish(
                item.turnId,
                Math.max(0L, player.getCurrentPosition()),
                duration == C.TIME_UNSET ? 0L : Math.max(0L, duration)
            );
        }
        handler.postDelayed(this, INTERVAL_MS);
    }
}
