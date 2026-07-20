package io.agentmux.audioinbox;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

public final class AudioInboxService extends MediaSessionService {
    static final String ACTION_REPLAY = "io.agentmux.audioinbox.REPLAY";
    private static final String STATUS_CHANNEL = "agent-audio-inbox-status";
    private static final int STATUS_NOTIFICATION_ID = 7301;
    private static final int MAX_AUDIO_BYTES = 10 * 1024 * 1024;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService feedExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService workExecutor = Executors.newSingleThreadExecutor();
    private final AtomicInteger feedGeneration = new AtomicInteger();
    private final Map<String, AudioItem> items = new HashMap<>();
    private final Set<String> processing = new HashSet<>();

    private SharedPreferences preferences;
    private ExoPlayer player;
    private MediaSession mediaSession;
    private DuckAudioFocus audioFocus;
    private PlaybackQueue playbackQueue;
    private volatile boolean enabled;
    private volatile boolean connected;
    private volatile HttpURLConnection feedConnection;
    private String startingId;

    private static final class AudioItem {
        final String eventId;
        final String text;
        final long createdAt;
        final long expiresAt;
        final File mediaFile;

        AudioItem(String eventId, String text, long createdAt, long expiresAt, File mediaFile) {
            this.eventId = eventId;
            this.text = text;
            this.createdAt = createdAt;
            this.expiresAt = expiresAt;
            this.mediaFile = mediaFile;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        preferences = getSharedPreferences(AppContract.PREFS, MODE_PRIVATE);
        createNotificationChannel();

        audioFocus = new DuckAudioFocus(this, change -> main.post(() -> {
            if (change <= 0 && player != null && player.isPlaying()) player.pause();
        }));
        playbackQueue = new PlaybackQueue(audioFocus);
        AudioAttributes attributes = new AudioAttributes.Builder()
            .setUsage(C.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
            .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
            .build();
        player = new ExoPlayer.Builder(this)
            .setAudioAttributes(attributes, false)
            .build();
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int playbackState) {
                if (playbackState == Player.STATE_ENDED) finishActiveAsPlayed();
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                failActive("player: " + safeDetail(error.getMessage()));
            }

            @Override
            public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
                if (!playWhenReady) {
                    playbackQueue.pauseActive();
                    return;
                }
                String active = playbackQueue.active();
                if (active == null) {
                    MediaItem current = player.getCurrentMediaItem();
                    if (current == null || !playbackQueue.replay(current.mediaId)) {
                        player.pause();
                    }
                } else if (!playbackQueue.ensureFocusForActive()) {
                    player.pause();
                }
            }
        });
        mediaSession = new MediaSession.Builder(this, player)
            .setId("agent-audio-inbox")
            .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        int parentResult = super.onStartCommand(intent, flags, startId);
        String action = intent == null ? null : intent.getAction();
        if (AppContract.ACTION_STOP.equals(action)) {
            stopHandsFree();
            return START_NOT_STICKY;
        }
        if (ACTION_REPLAY.equals(action)) {
            replayCurrent();
            return START_STICKY;
        }
        if (AppContract.ACTION_START.equals(action)
            || (action == null && preferences.getBoolean(AppContract.KEY_ENABLED, false))) {
            startHandsFree();
            return START_STICKY;
        }
        return parentResult;
    }

    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return mediaSession;
    }

    @Override
    public void onDestroy() {
        enabled = false;
        feedGeneration.incrementAndGet();
        disconnectFeed();
        playbackQueue.setHandsFree(false);
        workExecutor.shutdownNow();
        feedExecutor.shutdownNow();
        mediaSession.release();
        player.release();
        super.onDestroy();
    }

    private void startHandsFree() {
        String server = serverUrl();
        String target = preferences.getString(AppContract.KEY_TARGET, "");
        if (server.isBlank() || target == null || target.isBlank()) {
            updateConnection("Configuration required", false);
            stopSelf();
            return;
        }
        enabled = true;
        preferences.edit().putBoolean(AppContract.KEY_ENABLED, true).apply();
        playbackQueue.setHandsFree(true);
        startStatusForeground();
        int generation = feedGeneration.incrementAndGet();
        updateConnection("Connecting", false);
        feedExecutor.execute(() -> runFeed(generation, server, target));
    }

    private void stopHandsFree() {
        enabled = false;
        connected = false;
        feedGeneration.incrementAndGet();
        preferences.edit().putBoolean(AppContract.KEY_ENABLED, false).apply();
        disconnectFeed();
        playbackQueue.setConnected(false);
        playbackQueue.setHandsFree(false);
        player.stop();
        updateConnection("Off", false);
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        stopSelf();
    }

    private void runFeed(int generation, String server, String target) {
        while (enabled && generation == feedGeneration.get()) {
            try {
                String consumer = AppContract.consumerId(preferences);
                URL url = new URL(server + "/api/audio/events?consumerId="
                    + encode(consumer) + "&target=" + encode(target) + "&limit=100");
                HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                feedConnection = connection;
                connection.setRequestMethod("GET");
                connection.setRequestProperty("Accept", "text/event-stream");
                connection.setConnectTimeout(10_000);
                connection.setReadTimeout(20_000);
                if (connection.getResponseCode() != 200) {
                    throw new IllegalStateException("feed HTTP " + connection.getResponseCode());
                }
                setConnected(true);
                readFeed(connection, generation);
            } catch (Exception error) {
                if (enabled && generation == feedGeneration.get()) {
                    updateConnection("Disconnected: " + safeDetail(error.getMessage()), false);
                }
            } finally {
                feedConnection = null;
                setConnected(false);
            }
            if (enabled && generation == feedGeneration.get()) {
                try {
                    Thread.sleep(2000);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
    }

    private void readFeed(HttpURLConnection connection, int generation) throws Exception {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
            connection.getInputStream(),
            StandardCharsets.UTF_8
        ))) {
            String eventName = "";
            String line;
            while (enabled && connected && generation == feedGeneration.get()
                && (line = reader.readLine()) != null) {
                if (line.startsWith("event:")) {
                    eventName = line.substring("event:".length()).trim();
                } else if (line.startsWith("data:") && "audio".equals(eventName)) {
                    JSONObject event = new JSONObject(line.substring("data:".length()).trim());
                    acceptEvent(event);
                } else if (line.isEmpty()) {
                    eventName = "";
                }
            }
        }
    }

    private void acceptEvent(JSONObject event) {
        String eventId = event.optString("eventId", "");
        String text = event.optString("text", "");
        if (eventId.isBlank() || text.isBlank() || text.length() > 1500) return;
        long createdAt;
        long expiresAt;
        try {
            createdAt = Instant.parse(event.getString("createdAt")).toEpochMilli();
            expiresAt = Instant.parse(event.getString("expiresAt")).toEpochMilli();
        } catch (Exception ignored) {
            return;
        }
        if (expiresAt <= System.currentTimeMillis()) return;
        synchronized (processing) {
            String local = localState(eventId);
            if ("playback-started".equals(local) || "played".equals(local)
                || "failed".equals(local) || !processing.add(eventId)) return;
        }
        workExecutor.execute(() -> {
            try {
                if (!canClaim()) return;
                postReceipt(eventId, "received", null);
                saveLocalState(eventId, "received");
                File media = fetchTts(eventId, text);
                if (!canClaim()) return;
                postReceipt(eventId, "queued", null);
                saveLocalState(eventId, "queued");
                AudioItem item = new AudioItem(eventId, text, createdAt, expiresAt, media);
                main.post(() -> queueItem(item));
            } catch (Exception error) {
                failBeforePlayback(eventId, error);
            } finally {
                synchronized (processing) {
                    processing.remove(eventId);
                }
            }
        });
    }

    private void queueItem(AudioItem item) {
        if (!enabled || !connected || item.expiresAt <= System.currentTimeMillis()) return;
        if (!playbackQueue.offer(item.eventId)) return;
        items.put(item.eventId, item);
        saveCurrent(item);
        maybeStartNext();
    }

    private void maybeStartNext() {
        if (!enabled || !connected || startingId != null) return;
        String candidate = playbackQueue.candidate();
        if (candidate == null) return;
        AudioItem item = items.get(candidate);
        if (item == null) {
            playbackQueue.discard(candidate);
            return;
        }
        startingId = candidate;
        workExecutor.execute(() -> {
            try {
                if (!canClaim()) throw new IllegalStateException("disconnected before playback receipt");
                postReceipt(candidate, "playback-started", null);
                saveLocalState(candidate, "playback-started");
                main.post(() -> startReserved(item));
            } catch (Exception error) {
                main.post(() -> {
                    startingId = null;
                    playbackQueue.discard(candidate);
                    maybeStartNext();
                });
            }
        });
    }

    private void startReserved(AudioItem item) {
        startingId = null;
        if (!enabled || !connected || !playbackQueue.start(item.eventId)) {
            playbackQueue.discard(item.eventId);
            workExecutor.execute(() -> markFailed(item.eventId, "audio focus denied"));
            maybeStartNext();
            return;
        }
        MediaMetadata metadata = new MediaMetadata.Builder()
            .setTitle(item.text)
            .setArtist("Agent update")
            .build();
        MediaItem mediaItem = new MediaItem.Builder()
            .setMediaId(item.eventId)
            .setUri(Uri.fromFile(item.mediaFile))
            .setMediaMetadata(metadata)
            .build();
        player.setMediaItem(mediaItem);
        player.prepare();
        player.play();
        updateConnection("Playing", true);
    }

    private void finishActiveAsPlayed() {
        String eventId = playbackQueue.active();
        if (eventId == null) return;
        AudioItem item = items.get(eventId);
        playbackQueue.complete(eventId);
        player.pause();
        player.seekTo(0);
        if (item != null) saveHistory("Played · " + item.text);
        workExecutor.execute(() -> {
            try {
                if (connected) postReceipt(eventId, "played", null);
                saveLocalState(eventId, "played");
            } catch (Exception ignored) {}
        });
        updateConnection(connected ? "Connected" : "Disconnected", connected);
        maybeStartNext();
    }

    private void failActive(String detail) {
        String eventId = playbackQueue.active();
        if (eventId == null) return;
        playbackQueue.discard(eventId);
        workExecutor.execute(() -> markFailed(eventId, detail));
        maybeStartNext();
    }

    private void failBeforePlayback(String eventId, Exception error) {
        if (!connected) return;
        markFailed(eventId, safeDetail(error.getMessage()));
    }

    private void markFailed(String eventId, String detail) {
        try {
            if (connected) postReceipt(eventId, "failed", detail);
        } catch (Exception ignored) {}
        saveLocalState(eventId, "failed");
        saveHistory("Failed · " + eventId + " · " + safeDetail(detail));
    }

    private File fetchTts(String eventId, String text) throws Exception {
        URL url = new URL(serverUrl() + "/api/tts");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("POST");
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(30_000);
        connection.setDoOutput(true);
        byte[] body = new JSONObject().put("text", text).toString().getBytes(StandardCharsets.UTF_8);
        connection.getOutputStream().write(body);
        if (connection.getResponseCode() != 200) {
            throw new IllegalStateException("tts HTTP " + connection.getResponseCode());
        }
        byte[] audio = readBounded(connection.getInputStream(), MAX_AUDIO_BYTES);
        File file = new File(getCacheDir(), "audio-" + eventId + ".mp3");
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(audio);
        }
        connection.disconnect();
        return file;
    }

    private void postReceipt(String eventId, String state, String detail) throws Exception {
        URL url = new URL(serverUrl() + "/api/audio/events/" + encode(eventId) + "/receipts");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("POST");
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(10_000);
        connection.setDoOutput(true);
        JSONObject body = new JSONObject()
            .put("consumerId", AppContract.consumerId(preferences))
            .put("state", state);
        if (detail != null) body.put("detail", safeDetail(detail));
        connection.getOutputStream().write(body.toString().getBytes(StandardCharsets.UTF_8));
        int status = connection.getResponseCode();
        connection.disconnect();
        if (status != 200 && status != 201) {
            throw new IllegalStateException("receipt " + state + " HTTP " + status);
        }
    }

    private void setConnected(boolean value) {
        if (connected == value) return;
        connected = value;
        main.post(() -> {
            playbackQueue.setConnected(value);
            if (!value && player.getPlayWhenReady()) player.pause();
            updateConnection(value ? "Connected" : "Disconnected", value);
            if (value) maybeStartNext();
        });
    }

    private void replayCurrent() {
        if (!enabled || !connected || player.getCurrentMediaItem() == null) return;
        player.seekTo(0);
        player.play();
    }

    private boolean canClaim() {
        return enabled && connected;
    }

    private String serverUrl() {
        String value = preferences.getString(AppContract.KEY_SERVER, "");
        return value == null ? "" : value.replaceAll("/+$", "");
    }

    private void disconnectFeed() {
        HttpURLConnection connection = feedConnection;
        if (connection != null) connection.disconnect();
        feedConnection = null;
    }

    private void saveLocalState(String eventId, String state) {
        preferences.edit().putString("event-state:" + eventId, state).apply();
    }

    private String localState(String eventId) {
        return preferences.getString("event-state:" + eventId, "");
    }

    private void saveCurrent(AudioItem item) {
        preferences.edit()
            .putString(AppContract.KEY_CURRENT, item.text)
            .putLong(AppContract.KEY_CURRENT_CREATED_AT, item.createdAt)
            .apply();
        broadcastStatus();
    }

    private void saveHistory(String line) {
        String existing = preferences.getString(AppContract.KEY_HISTORY, "");
        ArrayDeque<String> rows = new ArrayDeque<>();
        rows.add(line);
        if (existing != null) {
            for (String row : existing.split("\n")) {
                if (!row.isBlank() && rows.size() < 5) rows.add(row);
            }
        }
        preferences.edit().putString(AppContract.KEY_HISTORY, String.join("\n", rows)).apply();
        broadcastStatus();
    }

    private void updateConnection(String state, boolean isConnected) {
        SharedPreferences.Editor edit = preferences.edit()
            .putString(AppContract.KEY_CONNECTION, state);
        if (isConnected) edit.putLong(AppContract.KEY_CONNECTED_AT, System.currentTimeMillis());
        edit.apply();
        broadcastStatus();
    }

    private void broadcastStatus() {
        Intent status = new Intent(AppContract.ACTION_STATUS);
        status.setPackage(getPackageName());
        sendBroadcast(status);
    }

    private void createNotificationChannel() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(
            STATUS_CHANNEL,
            "Hands-free connection",
            NotificationManager.IMPORTANCE_LOW
        ));
    }

    private void startStatusForeground() {
        PendingIntent open = PendingIntent.getActivity(
            this,
            0,
            new Intent(this, MainActivity.class),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        Notification notification = new Notification.Builder(this, STATUS_CHANNEL)
            .setSmallIcon(android.R.drawable.ic_lock_silent_mode_off)
            .setContentTitle("Agent Audio Inbox")
            .setContentText("Hands-free is on")
            .setContentIntent(open)
            .setOngoing(true)
            .build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(
                STATUS_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            );
        } else {
            startForeground(STATUS_NOTIFICATION_ID, notification);
        }
    }

    private static String encode(String value) {
        return Uri.encode(value);
    }

    private static byte[] readBounded(InputStream input, int maxBytes) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int total = 0;
        int read;
        while ((read = input.read(buffer)) != -1) {
            total += read;
            if (total > maxBytes) throw new IllegalStateException("audio clip exceeds 10 MiB");
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static String safeDetail(String value) {
        String clean = value == null ? "unknown" : value.replaceAll("[\\r\\n]+", " ").trim();
        return clean.substring(0, Math.min(clean.length(), 160));
    }
}
