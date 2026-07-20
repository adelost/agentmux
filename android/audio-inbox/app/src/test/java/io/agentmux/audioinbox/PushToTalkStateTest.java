package io.agentmux.audioinbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PushToTalkStateTest {
    @Test
    public void onePressReleaseProducesExactlyOneSendDisposition() {
        PushToTalkState state = new PushToTalkState();
        assertTrue(state.begin("turn-1", 1_000));
        assertEquals(PushToTalkState.Release.SEND, state.release(1_500));
        assertEquals("turn-1", state.turnId());
        assertEquals(PushToTalkState.Release.IGNORE, state.release(1_600));
        assertFalse(state.begin("turn-2", 1_700));
        assertTrue(state.finish());
        assertNull(state.turnId());
    }

    @Test
    public void shortOrCancelledPressNeverSends() {
        PushToTalkState state = new PushToTalkState();
        state.begin("short", 1_000);
        assertEquals(PushToTalkState.Release.TOO_SHORT, state.release(1_100));
        assertEquals(PushToTalkState.Phase.IDLE, state.phase());
        state.begin("cancelled", 2_000);
        assertTrue(state.cancel());
        assertEquals(PushToTalkState.Release.IGNORE, state.release(3_000));
    }
}
