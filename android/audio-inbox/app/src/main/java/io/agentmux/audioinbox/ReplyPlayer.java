package io.agentmux.audioinbox;

import android.app.Activity;
import android.media.MediaPlayer;

import java.io.File;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Fetches and plays reply voice files. One shared MediaPlayer behind the
 * speech focus port; a voice file belongs to one message key and stays for
 * Replay. Async fetches are fenced by a generation so stale completions
 * never start playback after a stop or close.
 */
final class ReplyPlayer implements AutoCloseable {
    interface Listener {
        void onState(String key, boolean playing, String error);
    }

    private final Activity activity;
    private final PlaybackQueue.FocusPort focus;
    private final Listener listener;
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private MediaPlayer player;
    private String activeKey;
    private int generation;
    private boolean closed;

    ReplyPlayer(Activity activity, PlaybackQueue.FocusPort focus, Listener listener) {
        this.activity = activity;
        this.focus = focus;
        this.listener = listener;
    }

    boolean isPlaying(String key) {
        return key != null && key.equals(activeKey);
    }

    /** Ensures the voice file exists, then plays it. */
    void play(AudioInboxHttpClient client, String key, String text) {
        final int expected = generation;
        work.execute(() -> {
            File file = ensure(client, key, text);
            activity.runOnUiThread(() -> {
                if (closed || expected != generation) return; // stale completion
                if (file == null) {
                    post(key, false, "Röstljudet kunde inte hämtas");
                    return;
                }
                startFile(key, file);
            });
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
        generation += 1;
        if (player != null) {
            try { if (player.isPlaying()) player.stop(); } catch (Exception ignored) {}
            player.release();
            player = null;
        }
        focus.abandon(); // idempotent: SpeechAudioFocus no-ops when nothing is held
        activeKey = null;
    }

    /** Deletes cached voice files that no current message references. */
    void prune(File cacheDir, Set<String> keepKeys) {
        File[] files = cacheDir.listFiles((dir, name) -> name.startsWith("audio-tts-") && name.endsWith(".mp3"));
        if (files == null) return;
        for (File file : files) {
            String key = file.getName().substring("audio-".length(), file.getName().length() - ".mp3".length());
            if (!keepKeys.contains(key)) file.delete();
        }
    }

    private File ensure(AudioInboxHttpClient client, String key, String text) {
        File file = new File(activity.getCacheDir(), "audio-" + key + ".mp3");
        if (file.exists() && file.length() > 0) return file;
        try {
            return client.fetchTts(activity.getCacheDir(), key, text);
        } catch (Exception error) {
            return null;
        }
    }

    private void startFile(String key, File file) {
        stopPlayback();
        if (!focus.requestSpeechFocus()) {
            post(key, false, "Ljudfokus nekades");
            return;
        }
        try {
            player = new MediaPlayer();
            player.setAudioAttributes(
                new android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            );
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
        closed = true;
        work.shutdownNow();
        stopPlayback();
    }
}
