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
import java.io.File;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
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

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService feedExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService workExecutor = Executors.newSingleThreadExecutor();
    private final AtomicInteger feedGeneration = new AtomicInteger();
    private final Map<String, AudioItem> items = new HashMap<>();
    private final Set<String> processing = new HashSet<>();

    private SharedPreferences preferences;
    private ExoPlayer player;
    private MediaSession mediaSession;
    private SpeechAudioFocus audioFocus;
    private PlaybackQueue playbackQueue;
    private AudioInboxHttpClient httpClient;
    private AudioInboxStore store;
    private volatile boolean enabled;
    private volatile boolean connected;
    private volatile HttpURLConnection feedConnection;
    private String startingId;
    private boolean replaying;

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
        store = new AudioInboxStore(this, preferences);
        createNotificationChannel();

        audioFocus = new SpeechAudioFocus(this, change -> main.post(() -> {
            if (change <= 0 && player != null && player.isPlaying()) player.pause();
        }));
        playbackQueue = new PlaybackQueue(audioFocus);
        AudioAttributes attributes = new AudioAttributes.Builder()
            .setUsage(C.USAGE_ASSISTANT)
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
        if (!ServerDiscovery.isAllowedServer(server)
            || target == null
            || !target.matches("^\\d{10,24}$")) {
            store.updateConnection("Configuration required", false);
            stopSelf();
            return;
        }
        httpClient = new AudioInboxHttpClient(
            server,
            AppContract.consumerId(preferences)
        );
        enabled = true;
        preferences.edit().putBoolean(AppContract.KEY_ENABLED, true).apply();
        playbackQueue.setHandsFree(true);
        startStatusForeground();
        int generation = feedGeneration.incrementAndGet();
        store.updateConnection("Connecting", false);
        feedExecutor.execute(() -> runFeed(generation, target));
    }

    private void stopHandsFree() {
        enabled = false;
        connected = false;
        feedGeneration.incrementAndGet();
        preferences.edit().putBoolean(AppContract.KEY_ENABLED, false).apply();
        disconnectFeed();
        playbackQueue.setConnected(false);
        playbackQueue.setHandsFree(false);
        replaying = false;
        player.stop();
        store.updateConnection("Off", false);
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        stopSelf();
    }

    private void runFeed(int generation, String target) {
        while (enabled && generation == feedGeneration.get()) {
            try {
                HttpURLConnection connection = httpClient.openFeed(target);
                feedConnection = connection;
                setConnected(true);
                readFeed(connection, generation);
            } catch (Exception error) {
                if (enabled && generation == feedGeneration.get()) {
                    store.updateConnection("Disconnected: " + safeDetail(error.getMessage()), false);
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
            String local = store.localState(eventId);
            if ("playback-started".equals(local) || "played".equals(local)
                || "failed".equals(local) || !processing.add(eventId)) return;
        }
        workExecutor.execute(() -> {
            try {
                if (!canClaim()) return;
                httpClient.postReceipt(eventId, "received", null);
                store.saveLocalState(eventId, "received");
                File media = httpClient.fetchTts(getCacheDir(), eventId, text);
                if (!canClaim()) return;
                httpClient.postReceipt(eventId, "queued", null);
                store.saveLocalState(eventId, "queued");
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
        store.saveCurrent(item.text, item.createdAt);
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
                httpClient.postReceipt(candidate, "playback-started", null);
                store.saveLocalState(candidate, "playback-started");
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
        replaying = false;
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
        store.updateConnection("Playing", true);
    }

    private void finishActiveAsPlayed() {
        String eventId = playbackQueue.active();
        if (eventId == null) return;
        boolean wasReplay = replaying;
        replaying = false;
        AudioItem item = items.get(eventId);
        playbackQueue.complete(eventId);
        player.pause();
        player.seekTo(0);
        if (!wasReplay && item != null) store.saveHistory("Played · " + item.text);
        if (wasReplay) {
            store.updateConnection(connected ? "Connected" : "Disconnected", connected);
            return;
        }
        workExecutor.execute(() -> {
            try {
                if (connected) httpClient.postReceipt(eventId, "played", null);
                store.saveLocalState(eventId, "played");
            } catch (Exception ignored) {}
        });
        store.updateConnection(connected ? "Connected" : "Disconnected", connected);
        maybeStartNext();
    }

    private void failActive(String detail) {
        String eventId = playbackQueue.active();
        if (eventId == null) return;
        boolean wasReplay = replaying;
        replaying = false;
        playbackQueue.discard(eventId);
        if (!wasReplay) workExecutor.execute(() -> markFailed(eventId, detail));
        maybeStartNext();
    }

    private void failBeforePlayback(String eventId, Exception error) {
        if (!connected) return;
        markFailed(eventId, safeDetail(error.getMessage()));
    }

    private void markFailed(String eventId, String detail) {
        try {
            if (connected) httpClient.postReceipt(eventId, "failed", safeDetail(detail));
        } catch (Exception ignored) {}
        store.saveLocalState(eventId, "failed");
        store.saveHistory("Failed · " + eventId + " · " + safeDetail(detail));
    }

    private void setConnected(boolean value) {
        if (connected == value) return;
        connected = value;
        main.post(() -> {
            playbackQueue.setConnected(value);
            if (!value && player.getPlayWhenReady()) player.pause();
            store.updateConnection(value ? "Connected" : "Disconnected", value);
            if (value) maybeStartNext();
        });
    }

    private void replayCurrent() {
        if (!enabled || !connected || player.getCurrentMediaItem() == null) return;
        replaying = true;
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

    private static String safeDetail(String value) {
        String clean = value == null ? "unknown" : value.replaceAll("[\\r\\n]+", " ").trim();
        return clean.substring(0, Math.min(clean.length(), 160));
    }
}
