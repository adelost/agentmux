package io.agentmux.audioinbox;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Set;

final class PlaybackQueue {
    enum Priority { DIRECT, BROADCAST }

    interface FocusPort {
        boolean requestSpeechFocus();
        void abandon();
    }

    private final FocusPort focus;
    private final ArrayDeque<String> direct = new ArrayDeque<>();
    private final ArrayDeque<String> broadcast = new ArrayDeque<>();
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
            for (String eventId : broadcast) known.remove(eventId);
            broadcast.clear();
        }
    }

    synchronized void setConnected(boolean value) {
        connected = value;
        if (!value) releaseFocus();
    }

    synchronized boolean offer(String eventId) {
        return offer(eventId, Priority.BROADCAST);
    }

    synchronized boolean offer(String eventId, Priority priority) {
        if (!connected || (priority == Priority.BROADCAST && !handsFree)
            || known.contains(eventId)) return false;
        known.add(eventId);
        (priority == Priority.DIRECT ? direct : broadcast).addLast(eventId);
        return true;
    }

    synchronized String candidate() {
        if (!connected || active != null) return null;
        return direct.isEmpty() ? broadcast.peekFirst() : direct.peekFirst();
    }

    synchronized boolean start(String eventId) {
        if (!eventId.equals(candidate()) || !focus.requestSpeechFocus()) return false;
        focusHeld = true;
        active = eventId;
        direct.remove(eventId);
        broadcast.remove(eventId);
        return true;
    }

    synchronized boolean ensureFocusForActive() {
        if (!connected || active == null) return false;
        if (focusHeld) return true;
        focusHeld = focus.requestSpeechFocus();
        return focusHeld;
    }

    synchronized boolean replay(String eventId) {
        if (!connected || active != null || eventId == null) return false;
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
        direct.remove(eventId);
        broadcast.remove(eventId);
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
