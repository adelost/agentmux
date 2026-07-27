package io.agentmux.audioinbox;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.util.List;

public class AudioInboxStoreTest {
    @Test
    public void onlyAmbiguousPlaybackReceiptsNeedRestartReconciliation() {
        TestPreferences preferences = new TestPreferences();
        preferences.data.put("event-state:interrupted", "playback-started");
        preferences.data.put("event-state:queued", "queued");
        preferences.data.put("event-state:stopped", "stopped");

        AudioInboxStore store = new AudioInboxStore(null, preferences);

        assertEquals(List.of("interrupted"), store.interruptedEventIds());
    }
}
