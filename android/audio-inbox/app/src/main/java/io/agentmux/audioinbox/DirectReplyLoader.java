package io.agentmux.audioinbox;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import java.io.File;
import java.util.concurrent.ExecutorService;

/** Validates and fetches one direct reply without coupling it to the feed. */
final class DirectReplyLoader {
    interface Listener {
        void onReserved();
        void onReady(AudioEventClaims.Entry item);
        void onFailed(String turnId, String eventId);
    }

    private final Context context;
    private final SharedPreferences preferences;
    private final AudioEventClaims claims;
    private final ExecutorService executor;
    private final Listener listener;

    DirectReplyLoader(
        Context context,
        SharedPreferences preferences,
        AudioEventClaims claims,
        ExecutorService executor,
        Listener listener
    ) {
        this.context = context;
        this.preferences = preferences;
        this.claims = claims;
        this.executor = executor;
        this.listener = listener;
    }

    boolean prepare(Intent intent, boolean explicitReplay) {
        String turnId = intent.getStringExtra(AppContract.EXTRA_TURN_ID);
        String text = intent.getStringExtra(AppContract.EXTRA_TEXT);
        String server = intent.getStringExtra(AppContract.EXTRA_SERVER);
        String label = intent.getStringExtra(AppContract.EXTRA_TARGET_LABEL);
        if (turnId == null || turnId.isBlank() || text == null || text.isBlank()
            || text.length() > 1500 || !ServerDiscovery.isAllowedServer(server)) return false;
        String previous = preferences.getString("turn-playback:" + turnId, "");
        if (!explicitReplay && ("stopped".equals(previous) || "played".equals(previous))) return true;
        String eventId = "direct-" + turnId + (explicitReplay
            ? "-replay-" + System.currentTimeMillis()
            : "");
        if (!claims.reserve(eventId)) return true;
        listener.onReserved();
        executor.execute(() -> fetch(eventId, turnId, text, server, label));
        return true;
    }

    private void fetch(String eventId, String turnId, String text, String server, String label) {
        try {
            AudioInboxHttpClient client = new AudioInboxHttpClient(
                server,
                AppContract.consumerId(preferences)
            );
            File media = client.fetchTts(context.getCacheDir(), eventId, text);
            listener.onReady(new AudioEventClaims.Entry(
                eventId,
                text,
                System.currentTimeMillis(),
                System.currentTimeMillis() + 10 * 60_000,
                media,
                true,
                turnId,
                label == null || label.isBlank() ? "Agent reply" : label
            ));
        } catch (Exception error) {
            claims.releaseAndDelete(context.getCacheDir(), eventId);
            listener.onFailed(turnId, eventId);
        }
    }
}
