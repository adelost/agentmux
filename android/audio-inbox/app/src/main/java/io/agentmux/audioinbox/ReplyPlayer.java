package io.agentmux.audioinbox;

import android.app.Activity;
import android.media.MediaPlayer;

import java.io.File;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Fetches and plays reply voice files. One shared MediaPlayer; a voice file
 * belongs to exactly one message key and stays on disk for Replay.
 */
final class ReplyPlayer implements AutoCloseable {
    interface Listener {
        void onState(String key, boolean playing, String error);
    }

    private final Activity activity;
    private final Listener listener;
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private MediaPlayer player;
    private String activeKey;

    ReplyPlayer(Activity activity, Listener listener) {
        this.activity = activity;
        this.listener = listener;
    }

    boolean isPlaying(String key) {
        return key != null && key.equals(activeKey);
    }

    /** Ensures the voice file exists, then plays it. */
    void play(AudioInboxHttpClient client, String key, String text) {
        work.execute(() -> {
            File file = ensure(client, key, text);
            if (file == null) {
                post(key, false, "Röstljudet kunde inte hämtas");
                return;
            }
            activity.runOnUiThread(() -> startFile(key, file));
        });
    }

    void toggle(AudioInboxHttpClient client, String key, String text) {
        if (isPlaying(key)) {
            stopPlayback();
            post(key, false, null);
        } else {
            play(client, key, text);
        }
    }

    void stopPlayback() {
        if (player != null) {
            try { if (player.isPlaying()) player.stop(); } catch (Exception ignored) {}
            player.release();
            player = null;
        }
        activeKey = null;
    }

    /** Deletes cached voice files that no current message references. */
    void prune(File cacheDir, Set<String> keepKeys) {
        File[] files = cacheDir.listFiles((dir, name) -> name.startsWith("tts-") && name.endsWith(".mp3"));
        if (files == null) return;
        for (File file : files) {
            String key = file.getName().replace(".mp3", "");
            if (!keepKeys.contains(key)) file.delete();
        }
    }

    private File ensure(AudioInboxHttpClient client, String key, String text) {
        File file = new File(activity.getCacheDir(), key + ".mp3");
        if (file.exists() && file.length() > 0) return file;
        try {
            return client.fetchTts(activity.getCacheDir(), key, text);
        } catch (Exception error) {
            return null;
        }
    }

    private void startFile(String key, File file) {
        stopPlayback();
        try {
            player = new MediaPlayer();
            player.setDataSource(file.getAbsolutePath());
            player.setOnCompletionListener(done -> {
                String finished = activeKey;
                stopPlayback();
                post(finished, false, null);
            });
            player.setOnErrorListener((mp, what, extra) -> {
                String failed = activeKey;
                stopPlayback();
                post(failed, false, "Uppspelning misslyckades");
                return true;
            });
            player.prepare();
            player.start();
            activeKey = key;
            post(key, true, null);
        } catch (Exception error) {
            stopPlayback();
            post(key, false, "Uppspelning misslyckades");
        }
    }

    private void post(String key, boolean playing, String error) {
        activity.runOnUiThread(() -> listener.onState(key, playing, error));
    }

    @Override
    public void close() {
        work.shutdownNow();
        stopPlayback();
    }
}
