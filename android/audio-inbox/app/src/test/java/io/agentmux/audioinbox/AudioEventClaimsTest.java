package io.agentmux.audioinbox;

import static org.junit.Assert.*;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileWriter;

public class AudioEventClaimsTest {
    @Rule
    public final TemporaryFolder folder = new TemporaryFolder();

    private File mp3(String name) throws Exception {
        File file = folder.newFile(name);
        try (FileWriter writer = new FileWriter(file)) {
            writer.write("FAKE-MP3");
        }
        return file;
    }

    @Test
    public void reservationBlocksDuplicateFetchUntilReleased() {
        AudioEventClaims claims = new AudioEventClaims();
        assertTrue(claims.reserve("evt-1"));
        assertFalse("a replayed SSE event must not refetch", claims.reserve("evt-1"));
        claims.release("evt-1");
        assertTrue("a reconnect after release retries exactly once", claims.reserve("evt-1"));
    }

    @Test
    public void releaseAndDeleteRemovesQueueSlotAndFile() throws Exception {
        AudioEventClaims claims = new AudioEventClaims();
        File media = mp3("audio-evt-2.mp3");
        claims.reserve("evt-2");
        claims.putQueued(new AudioEventClaims.Entry("evt-2", "text", 1, 2, media));
        claims.releaseAndDelete(folder.getRoot(), "evt-2");
        assertNull(claims.queued("evt-2"));
        assertFalse(media.exists());
        assertFalse(claims.isReserved("evt-2"));
        // Falls back to the cache file name when nothing is queued.
        File orphan = mp3("audio-evt-3.mp3");
        claims.releaseAndDelete(folder.getRoot(), "evt-3");
        assertFalse(orphan.exists());
    }

    @Test
    public void rotateReplayFileDeletesOnlyThePrevious() throws Exception {
        AudioEventClaims claims = new AudioEventClaims();
        File first = mp3("audio-evt-4.mp3");
        File second = mp3("audio-evt-5.mp3");
        claims.rotateReplayFile(first);
        claims.rotateReplayFile(second);
        assertFalse(first.exists());
        assertTrue(second.exists());
    }

    @Test
    public void clearDropsReservationsQueueAndReplayFile() throws Exception {
        AudioEventClaims claims = new AudioEventClaims();
        File queued = mp3("audio-evt-6.mp3");
        File replay = mp3("audio-evt-7.mp3");
        claims.reserve("evt-6");
        claims.putQueued(new AudioEventClaims.Entry("evt-6", "text", 1, 2, queued));
        claims.rotateReplayFile(replay);
        claims.clear();
        assertFalse(queued.exists());
        assertFalse(replay.exists());
        assertFalse(claims.isReserved("evt-6"));
        assertTrue(claims.queuedEntries().isEmpty());
        assertTrue("after clear the event may be fetched again", claims.reserve("evt-6"));
    }
}
