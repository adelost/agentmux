package io.agentmux.audioinbox;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import java.io.File;
import java.util.concurrent.ExecutorService;

/** Validates and fetches one direct reply without coupling it to the feed. */
final class DirectReplyLoader {
    interface Listener {
        void onReplace();
        void onReserved(String turnId);
        void onReady(AudioEventClaims.Entry item, long epoch);
        void onCancelled(String turnId);
        void onFailed(String turnId, long epoch);
    }

    private final Context context;
    private final SharedPreferences preferences;
    private final AudioEventClaims claims;
    private final ExecutorService executor;
    private final Listener listener;
    private final ReplyAudioCache cache;
    private final PlaybackRequestEpoch requests = new PlaybackRequestEpoch();
    private final java.util.Map<String, String> pending = new java.util.HashMap<>();

    synchronized void cancelPending() {
        requests.invalidate();
        pending.forEach((eventId, turnId) -> {
            claims.releaseAndDelete(context.getCacheDir(), eventId);
            listener.onCancelled(turnId);
        });
        pending.clear();
    }

    synchronized boolean acceptReady(String eventId, long epoch) {
        pending.remove(eventId);
        return requests.accepts(epoch) && claims.isReserved(eventId);
    }

    boolean accepts(long epoch) { return requests.accepts(epoch); }
    synchronized boolean hasPending() { return !pending.isEmpty(); }

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
        this.cache = new ReplyAudioCache(context.getCacheDir());
    }

    synchronized boolean prepare(Intent intent, boolean explicitReplay) {
        String turnId = intent.getStringExtra(AppContract.EXTRA_TURN_ID);
        String text = intent.getStringExtra(AppContract.EXTRA_TEXT);
        String server = intent.getStringExtra(AppContract.EXTRA_SERVER);
        String label = intent.getStringExtra(AppContract.EXTRA_TARGET_LABEL);
        if (turnId == null || turnId.isBlank() || text == null || text.isBlank()
            || text.length() > AppContract.MAX_REPLY_AUDIO_CHARACTERS
            || !ServerDiscovery.isAllowedServer(server)) return false;
        String previous = preferences.getString("turn-playback:" + turnId, "");
        if (!explicitReplay && ("stopped".equals(previous) || "played".equals(previous))) return true;
        if (explicitReplay) {
            cancelPending();
            listener.onReplace();
        }
        long epoch = requests.current();
        String eventId = "direct-" + turnId + (explicitReplay
            ? "-replay-" + System.currentTimeMillis()
            : "");
        if (!claims.reserve(eventId)) return true;
        pending.put(eventId, turnId);
        listener.onReserved(turnId);
        executor.execute(() -> fetch(eventId, turnId, text, server, label, epoch));
        return true;
    }

    private void fetch(String eventId, String turnId, String text, String server, String label, long epoch) {
        try {
            AudioInboxHttpClient client = new AudioInboxHttpClient(
                server,
                AppContract.consumerId(preferences)
            );
            File media = cache.materialize(server, text,
                new File(context.getCacheDir(), "audio-" + eventId + ".mp3"),
                () -> client.fetchTts(context.getCacheDir(), eventId, text));
            if (!requests.accepts(epoch)) {
                claims.releaseAndDelete(context.getCacheDir(), eventId);
                return;
            }
            listener.onReady(new AudioEventClaims.Entry(
                eventId,
                text,
                System.currentTimeMillis(),
                System.currentTimeMillis() + 10 * 60_000,
                media,
                true,
                turnId,
                label == null || label.isBlank() ? "Agent reply" : label
            ), epoch);
        } catch (Exception error) {
            claims.releaseAndDelete(context.getCacheDir(), eventId);
            synchronized (this) {
                pending.remove(eventId);
                if (requests.accepts(epoch)) listener.onFailed(turnId, epoch);
            }
        }
    }
}
