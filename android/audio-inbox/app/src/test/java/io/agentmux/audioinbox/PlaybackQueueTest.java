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
        public boolean requestSpeechFocus() {
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

    @Test
    public void directRepliesOutrankBroadcastsAndRemainFifoWithinEachClass() {
        FakeFocus focus = new FakeFocus();
        PlaybackQueue queue = new PlaybackQueue(focus);
        queue.setHandsFree(true);
        queue.setConnected(true);
        queue.offer("broadcast-1", PlaybackQueue.Priority.BROADCAST);
        queue.offer("direct-1", PlaybackQueue.Priority.DIRECT);
        queue.offer("direct-2", PlaybackQueue.Priority.DIRECT);
        queue.offer("broadcast-2", PlaybackQueue.Priority.BROADCAST);

        assertEquals("direct-1", queue.candidate());
        assertTrue(queue.start("direct-1"));
        assertEquals("direct-2", queue.complete("direct-1"));
        assertTrue(queue.start("direct-2"));
        assertEquals("broadcast-1", queue.complete("direct-2"));
        assertTrue(queue.start("broadcast-1"));
        assertEquals("broadcast-2", queue.complete("broadcast-1"));
    }

    @Test
    public void directReplyCanPlayWhileHandsFreeBroadcastsAreOff() {
        FakeFocus focus = new FakeFocus();
        PlaybackQueue queue = new PlaybackQueue(focus);
        queue.setConnected(true);

        assertFalse(queue.offer("broadcast", PlaybackQueue.Priority.BROADCAST));
        assertTrue(queue.offer("direct", PlaybackQueue.Priority.DIRECT));
        assertEquals("direct", queue.candidate());
    }
}
