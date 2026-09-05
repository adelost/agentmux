package io.agentmux.audioinbox;

import org.junit.Test;
import static org.junit.Assert.*;

public class PlaybackRequestEpochTest {
    @Test public void newerManualChoiceAndStopRejectLateAudioEvenAfterFetch() {
        PlaybackRequestEpoch requests = new PlaybackRequestEpoch();
        long a = requests.current();
        requests.invalidate(); // B replaces A
        long b = requests.current();
        assertFalse(requests.accepts(a));
        assertTrue(requests.accepts(b));
        requests.invalidate(); // Stop before B reaches main/player
        assertFalse(requests.accepts(a));
        assertFalse(requests.accepts(b));
    }
}
