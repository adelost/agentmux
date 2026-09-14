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

    @Test public void byteBudgetBoundsRetainedAudio() throws Exception {
        AtomicLong now = new AtomicLong(1_700_000_000_000L);
        ReplyAudioCache cache = new ReplyAudioCache(folder.getRoot(), now::get);
        File output = new File(folder.getRoot(), "playing.mp3");
        ReplyAudioCache.Fetch fetch = () -> {
            try (var file = new java.io.RandomAccessFile(output, "rw")) { file.setLength(9 * 1024 * 1024); }
            return output;
        };
        for (int i = 0; i < 12; i++) {
            now.incrementAndGet();
            cache.materialize("server", "Reply " + i, output, fetch);
        }
        File[] files = new File(folder.getRoot(), "reply-audio").listFiles();
        assertNotNull(files);
        assertTrue(java.util.Arrays.stream(files).mapToLong(File::length).sum() <= ReplyAudioCache.MAX_BYTES);
    }

    // The conversation asks which replies are saved while speech is still being made; that answer must not wait on the network.
    @Test public void aReplyBeingSpokenNeitherBlocksTheSavedCheckNorIsAskedForTwice() throws Exception {
        ReplyAudioCache cache = new ReplyAudioCache(folder.getRoot());
        java.util.concurrent.CountDownLatch serverAnswers = new java.util.concurrent.CountDownLatch(1);
        AtomicInteger requests = new AtomicInteger();
        ReplyAudioCache.Fetch slowServer = () -> {
            requests.incrementAndGet();
            serverAnswers.await();
            File made = File.createTempFile("tts-", ".mp3", folder.getRoot());
            Files.write(made.toPath(), new byte[] {4, 5, 6});
            return made;
        };
        var pool = java.util.concurrent.Executors.newFixedThreadPool(3);
        var prefetch = pool.submit(() -> cache.materialize("server", "Reply", new File(folder.getRoot(), "prefetch.mp3"), slowServer));
        while (requests.get() == 0) Thread.sleep(5);
        var tap = pool.submit(() -> cache.materialize("server", "Reply", new File(folder.getRoot(), "tap.mp3"), slowServer));

        var savedCheck = pool.submit(() -> cache.saved("server", "Reply"));
        assertNull(savedCheck.get(1, java.util.concurrent.TimeUnit.SECONDS));

        serverAnswers.countDown();
        prefetch.get(5, java.util.concurrent.TimeUnit.SECONDS);
        assertArrayEquals(new byte[] {4, 5, 6}, Files.readAllBytes(tap.get(5, java.util.concurrent.TimeUnit.SECONDS).toPath()));
        assertEquals(1, requests.get());
        pool.shutdownNow();
    }

    // Mattias 2026-09-14: keep the ten newest across restarts; an older one is pruned, not failed.
    @Test public void theTenNewestSurviveARestartAndTheEleventhOldestIsPruned() throws Exception {
        AtomicLong now = new AtomicLong(1_700_000_000_000L);
        File output = new File(folder.getRoot(), "playing.mp3");
        ReplyAudioCache.Fetch fetch = () -> {
            java.nio.file.Files.write(output.toPath(), new byte[] { 1, 2, 3 });
            return output;
        };
        ReplyAudioCache beforeRestart = new ReplyAudioCache(folder.getRoot(), now::get);
        for (int i = 0; i < 11; i++) {
            now.addAndGet(60L * 60 * 1000 * 30); // hours apart: age alone never prunes
            beforeRestart.materialize("server", "Reply " + i, output, fetch);
        }
        ReplyAudioCache afterRestart = new ReplyAudioCache(folder.getRoot(), now::get);
        assertNull(afterRestart.saved("server", "Reply 0"));
        for (int i = 1; i < 11; i++) assertNotNull("Reply " + i, afterRestart.saved("server", "Reply " + i));
    }
}
