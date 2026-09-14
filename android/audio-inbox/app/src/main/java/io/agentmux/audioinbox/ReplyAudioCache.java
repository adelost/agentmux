package io.agentmux.audioinbox;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.function.LongSupplier;

/** The ten newest generated replies, kept on disk across restarts (Mattias 2026-09-14: "de tio senaste").
 * Playback gets its own copy: AudioEventClaims may delete that copy without deleting audio retained for a later replay. */
final class ReplyAudioCache {
    static final long MAX_BYTES = 32L * 1024 * 1024;
    static final long MAX_FILE_BYTES = 10L * 1024 * 1024;
    static final int MAX_FILES = 10;
    interface Fetch { File get() throws Exception; }
    private final File directory;
    private final LongSupplier clock;
    private final Map<String, CompletableFuture<File>> inFlight = new HashMap<>();

    ReplyAudioCache(File storageDir) { this(storageDir, System::currentTimeMillis); }
    ReplyAudioCache(File storageDir, LongSupplier clock) {
        this.directory = new File(storageDir, "reply-audio");
        this.clock = clock;
    }

    /** The kept audio for exactly this server and text, or null once it has been pruned or never made. */
    synchronized File saved(String server, String text) throws Exception {
        File cached = new File(directory, key(server, text) + ".audio");
        return cached.isFile() && cached.length() > 0 ? cached : null;
    }

    /** A playback copy of the kept audio; AudioEventClaims may delete the copy, never the kept file. */
    File materialize(String server, String text, File destination, Fetch fetch) throws Exception {
        File kept = keep(server, text, fetch);
        synchronized (this) {
            if (!kept.isFile()) throw new IOException("Audio was pruned before playback");
            Files.copy(kept.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING);
        }
        return destination;
    }

    /** Keeps the audio for this server and text, asking the server at most once even when a tap races a prefetch.
     * The network wait happens outside the lock, so saved() answers immediately while speech is being made. */
    File keep(String server, String text, Fetch fetch) throws Exception {
        String key = key(server, text);
        CompletableFuture<File> making;
        boolean mine = false;
        synchronized (this) {
            File cached = new File(directory, key + ".audio");
            if (cached.isFile() && cached.length() > 0) return cached;
            making = inFlight.get(key);
            if (making == null) {
                making = new CompletableFuture<>();
                inFlight.put(key, making);
                mine = true;
            }
        }
        if (!mine) return awaitOther(making);
        try {
            File kept = store(key, fetch.get());
            making.complete(kept);
            return kept;
        } catch (Exception error) {
            making.completeExceptionally(error);
            throw error;
        } finally {
            synchronized (this) { inFlight.remove(key); }
        }
    }

    private static File awaitOther(CompletableFuture<File> making) throws Exception {
        try {
            return making.get();
        } catch (ExecutionException failed) {
            throw failed.getCause() instanceof Exception ? (Exception) failed.getCause() : failed;
        }
    }

    private synchronized File store(String key, File received) throws Exception {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot open audio cache");
        if (received.length() <= 0 || received.length() > MAX_FILE_BYTES) {
            received.delete();
            throw new IOException("Audio response is empty or too large");
        }
        long now = clock.getAsLong();
        prune(now, received.length(), 1); // Reserve the pending file before copying bytes.
        File cached = new File(directory, key + ".audio");
        File temporary = File.createTempFile("pending-", ".part", directory);
        try {
            Files.copy(received.toPath(), temporary.toPath(), StandardCopyOption.REPLACE_EXISTING);
            Files.move(temporary.toPath(), cached.toPath(), StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE);
            if (!cached.setLastModified(now)) throw new IOException("Cannot date cached audio");
        } finally {
            temporary.delete();
            received.delete();
        }
        prune(now);
        return cached;
    }

    private void prune(long now) throws IOException { prune(now, 0, 0); }


    private void prune(long now, long reservedBytes, int reservedFiles) throws IOException {
        File[] files = directory.listFiles();
        if (files == null) throw new IOException("Cannot read audio cache");
        Arrays.sort(files, Comparator.comparingLong(File::lastModified).reversed());
        long bytes = 0;
        int count = 0;
        for (File file : files) {
            long size = file.length();
            if (!file.getName().endsWith(".audio") || size <= 0 || size > MAX_FILE_BYTES ||
                count >= MAX_FILES - reservedFiles ||
                bytes + size > MAX_BYTES - reservedBytes) {
                if (!file.delete()) throw new IOException("Cannot prune audio cache");
            } else {
                count++;
                bytes += size;
            }
        }
    }

    private static String key(String server, String text) throws Exception {
        // Exact request identity. Never reuse another server's voice or edited text.
        byte[] hash = MessageDigest.getInstance("SHA-256")
            .digest(("tts-v1\n" + server + "\n" + text).getBytes(StandardCharsets.UTF_8));
        StringBuilder key = new StringBuilder();
        for (byte part : hash) key.append(String.format(java.util.Locale.ROOT, "%02x", part & 255));
        return key.toString();
    }
}
