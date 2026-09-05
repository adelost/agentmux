package io.agentmux.audioinbox;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import org.json.JSONObject;
import java.io.File;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class AudioInboxService extends MediaSessionService {
    static final String ACTION_REPLAY = "io.agentmux.audioinbox.REPLAY";
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService workExecutor = Executors.newSingleThreadExecutor();
    private final AudioEventClaims claims = new AudioEventClaims();
    private SharedPreferences preferences;
    private ExoPlayer player;
    private MediaSession mediaSession;
    private SpeechAudioFocus audioFocus;
    private PlaybackQueue playbackQueue;
    private AudioInboxHttpClient httpClient;
    private AudioInboxStore store;
    private AudioReceiptWriter receipts;
    private AudioFeedLoop feedLoop;
    private AudioServiceNotifier notifier;
    private DirectReplyLoader directLoader;
    private PlaybackProgressPublisher progressPublisher;
    private volatile boolean enabled;
    private volatile boolean connected;
    private volatile boolean directAvailable;
    private String startingId;
    private boolean replaying;

    @Override
    public void onCreate() {
        super.onCreate();
        preferences = getSharedPreferences(AppContract.PREFS, MODE_PRIVATE);
        store = new AudioInboxStore(this, preferences);
        receipts = new AudioReceiptWriter(store, claims);
        notifier = new AudioServiceNotifier(this);

        audioFocus = new SpeechAudioFocus(this, change -> main.post(() -> {
            if (change <= 0 && player != null && player.isPlaying()) player.pause();
        }));
        playbackQueue = new PlaybackQueue(audioFocus);
        feedLoop = new AudioFeedLoop(new AudioFeedLoop.Listener() {
            public void onConnected(boolean value) { setConnected(value); }
            public void onEvent(JSONObject event) { acceptEvent(event); }
            public void onError(String detail) {
                if (enabled) store.updateConnection(
                    "Disconnected: " + AudioReceiptWriter.safe(detail),
                    false
                );
            }
        });
        directLoader = new DirectReplyLoader(
            this,
            preferences,
            claims,
            workExecutor,
            new DirectReplyLoader.Listener() {
                public void onReplace() { stopAllAudio(false); }
                public void onReserved(String turnId) {
                    directAvailable = true;
                    playbackQueue.setConnected(true);
                    store.saveTurnPlayback(turnId, "queued");
                }
                public void onCancelled(String turnId) { store.saveTurnPlayback(turnId, "stopped"); }
                public void onReady(AudioEventClaims.Entry item, long epoch) {
                    main.post(() -> {
                        if (directLoader.acceptReady(item.eventId, epoch)) queueItem(item);
                        else claims.releaseAndDelete(getCacheDir(), item.eventId);
                    });
                }
                public void onFailed(String turnId, long epoch) {
                    main.post(() -> {
                        if (!directLoader.accepts(epoch)) return;
                        store.saveTurnPlayback(turnId, "failed");
                        refreshDirectAvailability();
                    });
                }
            }
        );
        AudioAttributes attributes = new AudioAttributes.Builder()
            .setUsage(C.USAGE_ASSISTANT)
            .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
            .build();
        player = new ExoPlayer.Builder(this)
            .setAudioAttributes(attributes, false)
            .build();
        player.addListener(new Player.Listener() {
            @Override public void onIsPlayingChanged(boolean playing) {
                if (playing) updateActiveTurnState("playing");
            }
            @Override
            public void onPlaybackStateChanged(int playbackState) {
                if (playbackState == Player.STATE_ENDED) finishActiveAsPlayed();
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                failActive("player: " + AudioReceiptWriter.safe(error.getMessage()));
            }

            @Override
            public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
                if (!playWhenReady) {
                    playbackQueue.pauseActive();
                    updateActiveTurnState("paused");
                    return;
                }
                String active = playbackQueue.active();
                if (active == null) {
                    MediaItem current = player.getCurrentMediaItem();
                    if (current == null || !playbackQueue.replay(current.mediaId)) {
                        player.pause();
                    } else {
                        // A media-button resume is a replay: never a second
                        // "played" receipt or history row for the same event.
                        replaying = true;
                    }
                } else if (!playbackQueue.ensureFocusForActive()) {
                    player.pause();
                }
            }
        });
        mediaSession = new MediaSession.Builder(this, player)
            .setId("agent-audio-inbox")
            .setCallback(new AudioSessionCallback(() -> stopAllAudio(true)))
            .build();
        notifier.attach(mediaSession, player);
        progressPublisher = PlaybackProgressPublisher.start(main, player, claims, playbackQueue);
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
        if (AppContract.ACTION_PLAY_REPLY.equals(action)
            || AppContract.ACTION_REPLAY_REPLY.equals(action)) {
            notifier.start();
            if (!directLoader.prepare(intent, AppContract.ACTION_REPLAY_REPLY.equals(action))) {
                stopForegroundAndSelf();
            }
            return START_STICKY;
        }
        if (AppContract.ACTION_PAUSE_AUDIO.equals(action)) {
            player.pause();
            return START_STICKY;
        }
        if (AppContract.ACTION_RESUME_AUDIO.equals(action)) { player.play(); return START_STICKY; }
        if (AppContract.ACTION_STOP_AUDIO.equals(action)) {
            stopAllAudio(true);
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
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) { return mediaSession; }
    @Override
    public void onDestroy() {
        progressPublisher.stop();
        enabled = false;
        feedLoop.close();
        playbackQueue.setHandsFree(false);
        workExecutor.shutdownNow();
        claims.clear();
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
        workExecutor.execute(() -> receipts.recoverInterrupted(httpClient));
        enabled = true;
        preferences.edit().putBoolean(AppContract.KEY_ENABLED, true).apply();
        playbackQueue.setHandsFree(true);
        notifier.start();
        store.updateConnection("Connecting", false);
        feedLoop.start(httpClient, target);
    }

    private void stopHandsFree() {
        enabled = false;
        connected = false;
        preferences.edit().putBoolean(AppContract.KEY_ENABLED, false).apply();
        feedLoop.stop();
        playbackQueue.setHandsFree(false);
        discardBroadcastItems();
        playbackQueue.setConnected(directAvailable);
        store.updateConnection("Off", false);
        if (!directAvailable) stopForegroundAndSelf();
    }

    private void acceptEvent(JSONObject event) {
        String rawId = event.optString("eventId", "");
        AudioFeedEvent parsed = AudioFeedEvent.parse(
            event,
            store.localState(rawId),
            System.currentTimeMillis()
        );
        if (parsed == null) return;
        // Runtime reservation before any fetch: a replayed SSE event must
        // never overwrite the file the queued entry already uses. Held only
        // while in flight, queued, or active; terminal paths release it.
        if (!claims.reserve(parsed.eventId())) return;
        workExecutor.execute(() -> {
            try {
                if (!canClaim()) {
                    claims.release(parsed.eventId());
                    return;
                }
                httpClient.postReceipt(parsed.eventId(), "received", null);
                store.saveLocalState(parsed.eventId(), "received");
                File media = httpClient.fetchTts(getCacheDir(), parsed.eventId(), parsed.text());
                if (!canClaim()) {
                    if (media != null) media.delete();
                    claims.release(parsed.eventId());
                    return;
                }
                httpClient.postReceipt(parsed.eventId(), "queued", null);
                store.saveLocalState(parsed.eventId(), "queued");
                AudioEventClaims.Entry item = new AudioEventClaims.Entry(
                    parsed.eventId(), parsed.text(), parsed.createdAt(), parsed.expiresAt(), media
                );
                main.post(() -> queueItem(item));
            } catch (Exception error) {
                failBeforePlayback(parsed.eventId(), error);
            }
        });
    }

    private void queueItem(AudioEventClaims.Entry item) {
        if (!claims.isReserved(item.eventId) || (!item.direct && (!enabled || !connected))
            || item.expiresAt <= System.currentTimeMillis()) {
            claims.releaseAndDelete(getCacheDir(), item.eventId);
            return;
        }
        PlaybackQueue.Priority priority = item.direct
            ? PlaybackQueue.Priority.DIRECT
            : PlaybackQueue.Priority.BROADCAST;
        if (!playbackQueue.offer(item.eventId, priority)) {
            claims.releaseAndDelete(getCacheDir(), item.eventId);
            return;
        }
        claims.putQueued(item);
        if (item.direct) store.saveTurnPlayback(item.turnId, "queued");
        else store.saveCurrent(item.text, item.createdAt);
        maybeStartNext();
    }

    private void maybeStartNext() {
        if ((!connected && !directAvailable) || startingId != null) return;
        String candidate = playbackQueue.candidate();
        if (candidate == null) return;
        AudioEventClaims.Entry item = claims.queued(candidate);
        if (item == null) {
            playbackQueue.discard(candidate);
            return;
        }
        if (item.expiresAt <= System.currentTimeMillis()) {
            // An item that expired while queued must never play stale audio.
            playbackQueue.discard(candidate);
            claims.releaseAndDelete(getCacheDir(), candidate);
            workExecutor.execute(() -> receipts.terminal(
                item, "skipped", "expired before playback", httpClient, connected
            ));
            maybeStartNext();
            return;
        }
        startingId = candidate;
        if (item.direct) {
            main.post(() -> startReserved(item));
            return;
        }
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
                    claims.releaseAndDelete(getCacheDir(), candidate);
                    workExecutor.execute(() -> receipts.failed(
                        candidate, AudioReceiptWriter.safe(error.getMessage()), httpClient, connected
                    ));
                    maybeStartNext();
                });
            }
        });
    }

    private void startReserved(AudioEventClaims.Entry item) {
        startingId = null;
        replaying = false;
        boolean available = item.direct ? directAvailable : enabled && connected;
        if (!available || !playbackQueue.start(item.eventId)) {
            playbackQueue.discard(item.eventId);
            claims.releaseAndDelete(getCacheDir(), item.eventId);
            workExecutor.execute(() -> receipts.terminal(
                item, "failed", "audio focus denied", httpClient, connected
            ));
            maybeStartNext();
            return;
        }
        player.setMediaItem(AudioPlaybackMedia.item(item));
        player.prepare();
        player.play();
        store.updateConnection("Playing", true);
    }

    private void finishActiveAsPlayed() {
        String eventId = playbackQueue.active();
        if (eventId == null) return;
        boolean wasReplay = replaying;
        replaying = false;
        AudioEventClaims.Entry item = claims.removeQueued(eventId);
        claims.release(eventId);
        playbackQueue.complete(eventId);
        player.pause();
        player.seekTo(0);
        if (!wasReplay && item != null) store.saveHistory("Played · " + item.text);
        if (item != null && item.direct) store.saveTurnPlayback(item.turnId, "played");
        if (wasReplay) {
            store.updateConnection(connected ? "Connected" : "Disconnected", connected);
            return;
        }
        if (item != null) claims.rotateReplayFile(item.mediaFile);
        if (item != null && !item.direct) {
            workExecutor.execute(() -> {
                try {
                    if (connected) httpClient.postReceipt(eventId, "played", null);
                    store.saveLocalState(eventId, "played");
                } catch (Exception ignored) {}
            });
        }
        refreshDirectAvailability();
        store.updateConnection(connected ? "Connected" : "Disconnected", connected);
        maybeStartNext();
    }

    private void failActive(String detail) {
        String eventId = playbackQueue.active();
        if (eventId == null) return;
        boolean wasReplay = replaying;
        replaying = false;
        playbackQueue.discard(eventId);
        if (!wasReplay) {
            AudioEventClaims.Entry item = claims.queued(eventId);
            claims.releaseAndDelete(getCacheDir(), eventId);
            workExecutor.execute(() -> receipts.terminal(
                item, "failed", detail, httpClient, connected
            ));
        } else {
            claims.release(eventId);
        }
        refreshDirectAvailability();
        maybeStartNext();
    }

    private void failBeforePlayback(String eventId, Exception error) {
        if (!connected) {
            claims.release(eventId);
            return;
        }
        claims.releaseAndDelete(getCacheDir(), eventId);
        receipts.failed(eventId, AudioReceiptWriter.safe(error.getMessage()), httpClient, connected);
    }

    private void stopAllAudio(boolean releaseIdleService) {
        directLoader.cancelPending();
        String activeId = playbackQueue.active();
        if (activeId != null) {
            AudioEventClaims.Entry item = claims.removeQueued(activeId);
            playbackQueue.discard(activeId);
            player.stop();
            player.clearMediaItems();
            claims.release(activeId);
            if (item != null) {
                claims.rotateReplayFile(item.mediaFile);
                if (item.direct) store.saveTurnPlayback(item.turnId, "stopped");
                else workExecutor.execute(() -> receipts.terminal(
                    item, "stopped", "stopped by user", httpClient, connected));
            }
        }
        for (AudioEventClaims.Entry item : claims.queuedEntries()) {
            playbackQueue.discard(item.eventId);
            claims.releaseAndDelete(getCacheDir(), item.eventId);
            workExecutor.execute(() -> receipts.terminal(
                item, "skipped", "queue stopped by user", httpClient, connected
            ));
        }
        replaying = false;
        startingId = null;
        audioFocus.abandon();
        if (releaseIdleService) refreshDirectAvailability();
        store.updateConnection(connected ? "Connected" : "Disconnected", connected);
    }
    private void discardBroadcastItems() {
        for (AudioEventClaims.Entry item : claims.queuedEntries()) {
            if (item.direct) continue;
            if (item.eventId.equals(playbackQueue.active())) {
                player.stop();
                player.clearMediaItems();
            }
            playbackQueue.discard(item.eventId);
            claims.releaseAndDelete(getCacheDir(), item.eventId);
            workExecutor.execute(() -> receipts.terminal(
                item, "skipped", "Hands-free turned off", httpClient, connected
            ));
        }
    }

    private void updateActiveTurnState(String state) {
        AudioEventClaims.Entry item = claims.queued(playbackQueue.active());
        if (item != null && item.direct) store.saveTurnPlayback(item.turnId, state);
    }

    private void refreshDirectAvailability() {
        boolean hasDirect = directLoader.hasPending() || claims.queuedEntries().stream().anyMatch(item -> item.direct);
        directAvailable = hasDirect;
        playbackQueue.setConnected(connected || hasDirect);
        if (!enabled && !hasDirect) stopForegroundAndSelf();
    }

    private void stopForegroundAndSelf() {
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        stopSelf();
    }

    private void setConnected(boolean value) {
        if (connected == value) return;
        connected = value;
        main.post(() -> {
            playbackQueue.setConnected(value || directAvailable);
            AudioEventClaims.Entry active = claims.queued(playbackQueue.active());
            if (!value && (active == null || !active.direct) && player.getPlayWhenReady()) player.pause();
            store.updateConnection(value ? "Connected" : "Disconnected", value);
            if (value) maybeStartNext();
        });
    }

    private void replayCurrent() {
        if ((!connected && !directAvailable) || player.getCurrentMediaItem() == null) return;
        replaying = playbackQueue.active() == null;
        player.seekTo(0);
        player.play();
    }

    private boolean canClaim() { return enabled && connected; }
    private String serverUrl() {
        String value = preferences.getString(AppContract.KEY_SERVER, "");
        return value == null ? "" : value.replaceAll("/+$", "");
    }
}
