package io.agentmux.audioinbox;

final class PushToTalkState {
    static final long MIN_RECORDING_MS = 350;

    enum Phase { IDLE, RECORDING, SENDING }
    enum Release { IGNORE, TOO_SHORT, SEND }

    private Phase phase = Phase.IDLE;
    private String turnId;
    private long startedAt;

    synchronized boolean begin(String nextTurnId, long now) {
        if (phase != Phase.IDLE || nextTurnId == null || nextTurnId.isBlank()) return false;
        phase = Phase.RECORDING;
        turnId = nextTurnId;
        startedAt = now;
        return true;
    }

    synchronized Release release(long now) {
        if (phase != Phase.RECORDING) return Release.IGNORE;
        if (now - startedAt < MIN_RECORDING_MS) {
            clear();
            return Release.TOO_SHORT;
        }
        phase = Phase.SENDING;
        return Release.SEND;
    }

    synchronized boolean cancel() {
        if (phase == Phase.IDLE) return false;
        clear();
        return true;
    }

    synchronized boolean finish() {
        if (phase != Phase.SENDING) return false;
        clear();
        return true;
    }

    synchronized Phase phase() {
        return phase;
    }

    synchronized String turnId() {
        return turnId;
    }

    private void clear() {
        phase = Phase.IDLE;
        turnId = null;
        startedAt = 0;
    }
}
