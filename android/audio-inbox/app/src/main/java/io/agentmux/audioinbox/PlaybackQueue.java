package io.agentmux.audioinbox;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Set;

final class PlaybackQueue {
    interface FocusPort {
        boolean requestSpeechFocus();
        void abandon();
    }

    private final FocusPort focus;
    private final ArrayDeque<String> pending = new ArrayDeque<>();
    private final Set<String> known = new HashSet<>();
    private boolean handsFree;
    private boolean connected;
    private boolean focusHeld;
    private String active;

    PlaybackQueue(FocusPort focus) {
        this.focus = focus;
    }

    synchronized void setHandsFree(boolean value) {
        handsFree = value;
        if (!value) {
            pending.clear();
            known.clear();
            active = null;
            releaseFocus();
        }
    }

    synchronized void setConnected(boolean value) {
        connected = value;
        if (!value) releaseFocus();
    }

    synchronized boolean offer(String eventId) {
        if (!handsFree || !connected || known.contains(eventId)) return false;
        known.add(eventId);
        pending.addLast(eventId);
        return true;
    }

    synchronized String candidate() {
        if (!handsFree || !connected || active != null) return null;
        return pending.peekFirst();
    }

    synchronized boolean start(String eventId) {
        if (!eventId.equals(candidate()) || !focus.requestSpeechFocus()) return false;
        focusHeld = true;
        active = pending.removeFirst();
        return true;
    }

    synchronized boolean ensureFocusForActive() {
        if (!handsFree || !connected || active == null) return false;
        if (focusHeld) return true;
        focusHeld = focus.requestSpeechFocus();
        return focusHeld;
    }

    synchronized boolean replay(String eventId) {
        if (!handsFree || !connected || active != null || eventId == null) return false;
        if (!focus.requestSpeechFocus()) return false;
        focusHeld = true;
        active = eventId;
        known.add(eventId);
        return true;
    }

    synchronized void pauseActive() {
        releaseFocus();
    }

    synchronized String complete(String eventId) {
        if (!eventId.equals(active)) return null;
        releaseFocus();
        active = null;
        return candidate();
    }

    synchronized void discard(String eventId) {
        pending.remove(eventId);
        if (eventId.equals(active)) {
            releaseFocus();
            active = null;
        }
    }

    synchronized String active() {
        return active;
    }

    private void releaseFocus() {
        if (focusHeld) focus.abandon();
        focusHeld = false;
    }
}
