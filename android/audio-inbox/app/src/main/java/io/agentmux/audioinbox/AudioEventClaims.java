package io.agentmux.audioinbox;

import java.io.File;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Owns the lifecycle of accepted audio events: the runtime reservation that
 * blocks duplicate fetches, the queued entries awaiting playback, and the
 * media files on disk. A reservation is held only while an event is in
 * flight, queued, or active; terminal paths release it so a reconnect can
 * retry exactly once. Every file delete has exactly one owner.
 */
final class AudioEventClaims {
    static final class Entry {
        final String eventId;
        final String text;
        final long createdAt;
        final long expiresAt;
        final File mediaFile;

        Entry(String eventId, String text, long createdAt, long expiresAt, File mediaFile) {
            this.eventId = eventId;
            this.text = text;
            this.createdAt = createdAt;
            this.expiresAt = expiresAt;
            this.mediaFile = mediaFile;
        }
    }

    private final Map<String, Entry> queued = new HashMap<>();
    private final Set<String> reserved = new HashSet<>();
    private File replayFile;

    /** Reserves an event for work; false when already held this process lifetime. */
    synchronized boolean reserve(String eventId) {
        return reserved.add(eventId);
    }

    /** Drops the reservation without touching queue state or files. */
    synchronized void release(String eventId) {
        reserved.remove(eventId);
    }

    synchronized boolean isReserved(String eventId) {
        return reserved.contains(eventId);
    }

    synchronized void putQueued(Entry entry) {
        queued.put(entry.eventId, entry);
    }

    synchronized Entry queued(String eventId) {
        return queued.get(eventId);
    }

    synchronized List<Entry> queuedEntries() {
        return new ArrayList<>(queued.values());
    }

    /**
     * Releases the reservation and removes any trace of the event: queue
     * slot and media file. Safe when only the cache file name is known.
     */
    synchronized void releaseAndDelete(File cacheDir, String eventId) {
        reserved.remove(eventId);
        Entry entry = queued.remove(eventId);
        File file = entry != null ? entry.mediaFile : new File(cacheDir, "audio-" + eventId + ".mp3");
        if (file != null) file.delete();
    }

    /** Removes the queue slot and returns it, keeping the file for playback. */
    synchronized Entry removeQueued(String eventId) {
        return queued.remove(eventId);
    }

    /** Keeps the just-played file for Replay; the previous replay file is gone. */
    synchronized void rotateReplayFile(File next) {
        if (replayFile != null && !replayFile.equals(next)) replayFile.delete();
        replayFile = next;
    }

    /** A stopped service keeps no reservations, no queue state, no audio files. */
    synchronized void clear() {
        for (Entry entry : queued.values()) {
            if (entry.mediaFile != null) entry.mediaFile.delete();
        }
        queued.clear();
        reserved.clear();
        if (replayFile != null) replayFile.delete();
        replayFile = null;
    }
}
