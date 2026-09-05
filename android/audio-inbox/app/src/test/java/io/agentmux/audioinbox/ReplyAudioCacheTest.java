package io.agentmux.audioinbox;

import java.io.File;
import java.nio.file.Files;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public class ReplyAudioCacheTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    @Test public void replaySurvivesPlayerCleanupAndProcessOwnerReplacement() throws Exception {
        AtomicInteger requests = new AtomicInteger();
        File output = new File(folder.getRoot(), "playing.mp3");
        ReplyAudioCache.Fetch fetch = () -> {
            requests.incrementAndGet();
            Files.write(output.toPath(), new byte[] {1, 2, 3});
            return output;
        };
        new ReplyAudioCache(folder.getRoot()).materialize("server-a", "Reply", output, fetch);
        assertTrue(output.delete()); // AudioEventClaims owns only this playback copy.
        new ReplyAudioCache(folder.getRoot()).materialize("server-a", "Reply", output, fetch);
        assertEquals(1, requests.get());
        assertArrayEquals(new byte[] {1, 2, 3}, Files.readAllBytes(output.toPath()));
        new ReplyAudioCache(folder.getRoot()).materialize("server-b", "Reply", output, fetch);
        new ReplyAudioCache(folder.getRoot()).materialize("server-a", "Changed", output, fetch);
        assertEquals(3, requests.get());
    }

    @Test public void expiryAndByteBudgetBoundRetainedAudio() throws Exception {
        AtomicLong now = new AtomicLong(1_700_000_000_000L);
        ReplyAudioCache cache = new ReplyAudioCache(folder.getRoot(), now::get);
        File output = new File(folder.getRoot(), "playing.mp3");
        AtomicInteger requests = new AtomicInteger();
        ReplyAudioCache.Fetch fetch = () -> {
            requests.incrementAndGet();
            try (var file = new java.io.RandomAccessFile(output, "rw")) { file.setLength(9 * 1024 * 1024); }
            return output;
        };
        for (int i = 0; i < 12; i++) {
            now.incrementAndGet();
            cache.materialize("server", "Reply " + i, output, fetch);
        }
        File[] files = new File(folder.getRoot(), "reply-audio").listFiles();
        assertNotNull(files);
        assertTrue(files.length <= ReplyAudioCache.MAX_FILES);
        assertTrue(java.util.Arrays.stream(files).mapToLong(File::length).sum() <= ReplyAudioCache.MAX_BYTES);
        now.addAndGet(ReplyAudioCache.TTL_MS);
        cache.materialize("server", "Reply 11", output, fetch);
        assertEquals(13, requests.get());
        assertEquals(1, new File(folder.getRoot(), "reply-audio").listFiles().length);
    }
}
