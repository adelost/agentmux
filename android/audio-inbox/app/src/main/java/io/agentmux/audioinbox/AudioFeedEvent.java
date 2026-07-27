package io.agentmux.audioinbox;

import org.json.JSONObject;

import java.time.Instant;
import java.util.Set;

/** Validated non-terminal event projected from the untrusted SSE payload. */
record AudioFeedEvent(String eventId, String text, long createdAt, long expiresAt) {
    private static final Set<String> TERMINAL = Set.of(
        "playback-started",
        "played",
        "stopped",
        "skipped",
        "failed"
    );

    static AudioFeedEvent parse(JSONObject event, String localState, long nowMs) {
        String eventId = event.optString("eventId", "");
        String text = event.optString("text", "");
        if (eventId.isBlank() || text.isBlank() || text.length() > 1500
            || TERMINAL.contains(localState)) return null;
        try {
            long createdAt = Instant.parse(event.getString("createdAt")).toEpochMilli();
            long expiresAt = Instant.parse(event.getString("expiresAt")).toEpochMilli();
            return expiresAt <= nowMs ? null : new AudioFeedEvent(eventId, text, createdAt, expiresAt);
        } catch (Exception ignored) {
            return null;
        }
    }
}
