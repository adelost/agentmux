package io.agentmux.audioinbox;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Comparator;
import java.util.function.LongSupplier;

/** Bounded disposable TTS cache. Playback gets its own copy: AudioEventClaims
 * may delete that copy without deleting audio retained for a later replay. */
final class ReplyAudioCache {
    static final long MAX_BYTES = 32L * 1024 * 1024;
    static final long MAX_FILE_BYTES = 10L * 1024 * 1024;
    static final long TTL_MS = 24L * 60 * 60 * 1000;
    static final int MAX_FILES = 10;
    interface Fetch { File get() throws Exception; }
    private final File directory;
    private final LongSupplier clock;

    ReplyAudioCache(File cacheDir) { this(cacheDir, System::currentTimeMillis); }
    ReplyAudioCache(File cacheDir, LongSupplier clock) {
        this.directory = new File(cacheDir, "reply-audio");
        this.clock = clock;
    }

    synchronized File materialize(String server, String text, File destination, Fetch fetch) throws Exception {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot open audio cache");
        long now = clock.getAsLong();
        prune(now);
        File cached = new File(directory, key(server, text) + ".audio");
        if (cached.isFile()) {
            Files.copy(cached.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING);
            return destination;
        }
        File received = fetch.get();
        if (received.length() <= 0 || received.length() > MAX_FILE_BYTES) {
            received.delete();
            throw new IOException("Audio response is empty or too large");
        }
        File temporary = File.createTempFile("pending-", ".part", directory);
        try {
            Files.copy(received.toPath(), temporary.toPath(), StandardCopyOption.REPLACE_EXISTING);
            Files.move(temporary.toPath(), cached.toPath(), StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE);
            if (!cached.setLastModified(now)) throw new IOException("Cannot date cached audio");
        } finally {
            temporary.delete();
        }
        prune(now);
        return received;
    }

    private void prune(long now) {
        File[] files = directory.listFiles();
        if (files == null) return;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified).reversed());
        long bytes = 0;
        int count = 0;
        for (File file : files) {
            long age = now - file.lastModified();
            long size = file.length();
            if (!file.getName().endsWith(".audio") || size <= 0 || size > MAX_FILE_BYTES ||
                age < 0 || age >= TTL_MS || count >= MAX_FILES || bytes + size > MAX_BYTES) {
                file.delete();
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
