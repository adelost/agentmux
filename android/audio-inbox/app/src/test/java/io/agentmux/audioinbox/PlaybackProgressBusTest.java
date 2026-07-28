package io.agentmux.audioinbox;

import static org.junit.Assert.assertEquals;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public final class PlaybackProgressBusTest {
    @Test
    public void publishesProcessLocalPlayerTruthWithoutPreferences() {
        List<PlaybackProgressBus.Snapshot> seen = new ArrayList<>();
        PlaybackProgressBus.Listener listener = seen::add;
        PlaybackProgressBus.addListener(listener);
        try {
            PlaybackProgressBus.publish("turn-progress", 2_500L, 8_000L);
        } finally {
            PlaybackProgressBus.removeListener(listener);
        }

        PlaybackProgressBus.Snapshot latest = seen.get(seen.size() - 1);
        assertEquals("turn-progress", latest.turnId());
        assertEquals(2_500L, latest.positionMs());
        assertEquals(8_000L, latest.durationMs());
    }
}
