package io.agentmux.audioinbox;

import static org.junit.Assert.*;

import org.junit.Test;

public class GenerationFenceTest {
    @Test
    public void lastRequestWinsAndCloseStalesEverything() {
        GenerationFence fence = new GenerationFence();
        int pendingA = fence.next();
        int pendingB = fence.next();
        assertTrue("A pending then B requested: A is stale", fence.isStale(pendingA));
        assertFalse("only B may start", fence.isStale(pendingB));
        fence.close();
        assertTrue("close: no callback ever", fence.isStale(pendingB));
        assertTrue(fence.isStale(fence.next()));
    }

    @Test
    public void deliberateStopInvalidatesPendingWithoutClosing() {
        GenerationFence fence = new GenerationFence();
        int pending = fence.next();
        fence.invalidate();
        assertTrue(fence.isStale(pending));
        assertFalse("a later request still starts after a stop", fence.isStale(fence.next()));
    }
}
