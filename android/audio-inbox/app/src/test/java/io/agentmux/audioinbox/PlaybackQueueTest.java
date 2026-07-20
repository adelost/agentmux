package io.agentmux.audioinbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PlaybackQueueTest {
    private static final class FakeFocus implements PlaybackQueue.FocusPort {
        int requests;
        int abandons;
        boolean grant = true;

        @Override
        public boolean requestMayDuck() {
            requests++;
            return grant;
        }

        @Override
        public void abandon() {
            abandons++;
        }
    }

    @Test
    public void offOrDisconnectedNeverQueuesOrRequestsFocus() {
        FakeFocus focus = new FakeFocus();
        PlaybackQueue queue = new PlaybackQueue(focus);

        assertFalse(queue.offer("event-1"));
        queue.setHandsFree(true);
        assertFalse(queue.offer("event-1"));
        assertNull(queue.candidate());
        assertEquals(0, focus.requests);
    }

    @Test
    public void itemsPlaySequentiallyWithTransientFocusReleasedBetweenClips() {
        FakeFocus focus = new FakeFocus();
        PlaybackQueue queue = new PlaybackQueue(focus);
        queue.setHandsFree(true);
        queue.setConnected(true);

        assertTrue(queue.offer("event-1"));
        assertTrue(queue.offer("event-2"));
        assertFalse(queue.offer("event-1"));
        assertEquals("event-1", queue.candidate());
        assertTrue(queue.start("event-1"));
        assertNull(queue.candidate());
        assertEquals("event-2", queue.complete("event-1"));
        assertEquals(1, focus.requests);
        assertEquals(1, focus.abandons);
        assertTrue(queue.start("event-2"));
        queue.complete("event-2");
        assertEquals(2, focus.requests);
        assertEquals(2, focus.abandons);
    }

    @Test
    public void disconnectReleasesFocusAndReconnectNeverAutoplaysAnAmbiguousClip() {
        FakeFocus focus = new FakeFocus();
        PlaybackQueue queue = new PlaybackQueue(focus);
        queue.setHandsFree(true);
        queue.setConnected(true);
        queue.offer("event-1");
        assertTrue(queue.start("event-1"));

        queue.setConnected(false);
        queue.setConnected(true);

        assertNull(queue.candidate());
        assertEquals("event-1", queue.active());
        assertEquals(1, focus.abandons);
        assertTrue(queue.ensureFocusForActive());
        assertEquals(2, focus.requests);
    }

    @Test
    public void deniedFocusKeepsTheClipQueued() {
        FakeFocus focus = new FakeFocus();
        focus.grant = false;
        PlaybackQueue queue = new PlaybackQueue(focus);
        queue.setHandsFree(true);
        queue.setConnected(true);
        queue.offer("event-1");

        assertFalse(queue.start("event-1"));
        assertEquals("event-1", queue.candidate());
        assertNull(queue.active());
    }
}
