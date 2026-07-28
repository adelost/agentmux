package io.agentmux.audioinbox;

import java.util.concurrent.CopyOnWriteArraySet;

/**
 * Process-local player progress. Position is presentation state, not durable
 * conversation truth, so it must not churn SharedPreferences twice a second.
 */
final class PlaybackProgressBus {
    record Snapshot(String turnId, long positionMs, long durationMs) {
        Snapshot {
            if (turnId == null || turnId.isBlank()) throw new IllegalArgumentException("turnId");
            if (positionMs < 0 || durationMs < 0) throw new IllegalArgumentException("time");
        }
    }

    interface Listener {
        void onProgress(Snapshot value);
    }

    private static final CopyOnWriteArraySet<Listener> LISTENERS = new CopyOnWriteArraySet<>();
    private static volatile Snapshot latest;

    private PlaybackProgressBus() {}

    static void publish(String turnId, long positionMs, long durationMs) {
        Snapshot value = new Snapshot(turnId, positionMs, durationMs);
        latest = value;
        for (Listener listener : LISTENERS) listener.onProgress(value);
    }

    static void addListener(Listener listener) {
        LISTENERS.add(listener);
        Snapshot value = latest;
        if (value != null) listener.onProgress(value);
    }

    static void removeListener(Listener listener) {
        LISTENERS.remove(listener);
    }
}
