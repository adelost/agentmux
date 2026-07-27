package io.agentmux.audioinbox;

/** Owns durable delivery-terminal transitions for direct and broadcast audio. */
final class AudioReceiptWriter {
    private final AudioInboxStore store;
    private final AudioEventClaims claims;

    AudioReceiptWriter(AudioInboxStore store, AudioEventClaims claims) {
        this.store = store;
        this.claims = claims;
    }

    void failed(
        String eventId,
        String detail,
        AudioInboxHttpClient client,
        boolean connected
    ) {
        claims.release(eventId);
        try {
            if (connected) client.postReceipt(eventId, "failed", safe(detail));
        } catch (Exception ignored) {}
        store.saveLocalState(eventId, "failed");
        store.saveHistory("Failed · " + eventId + " · " + safe(detail));
    }

    void recoverInterrupted(AudioInboxHttpClient client) {
        for (String eventId : store.interruptedEventIds()) {
            try {
                client.postReceipt(eventId, "failed", "app restarted during playback");
                store.saveLocalState(eventId, "failed");
            } catch (Exception ignored) {
                // Keep playback-started so a later service restart retries reconciliation.
            }
        }
    }

    void terminal(
        AudioEventClaims.Entry item,
        String state,
        String detail,
        AudioInboxHttpClient client,
        boolean connected
    ) {
        if (item == null) return;
        if (item.direct) {
            store.saveTurnPlayback(item.turnId, state);
            return;
        }
        claims.release(item.eventId);
        try {
            if (connected) client.postReceipt(item.eventId, state, safe(detail));
        } catch (Exception ignored) {}
        store.saveLocalState(item.eventId, state);
        store.saveHistory(capitalize(state) + " · " + item.text);
    }

    static String safe(String value) {
        String clean = value == null ? "unknown" : value.replaceAll("[\\r\\n]+", " ").trim();
        return clean.substring(0, Math.min(clean.length(), 160));
    }

    private static String capitalize(String value) {
        if (value == null || value.isEmpty()) return "";
        return Character.toUpperCase(value.charAt(0)) + value.substring(1);
    }
}
