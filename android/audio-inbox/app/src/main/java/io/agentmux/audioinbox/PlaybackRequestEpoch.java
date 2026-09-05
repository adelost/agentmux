package io.agentmux.audioinbox;

/** Stop or a newer manual selection invalidates unfinished audio fetches. */
final class PlaybackRequestEpoch {
    private long epoch;
    synchronized long current() { return epoch; }
    synchronized void invalidate() { epoch++; }
    synchronized boolean accepts(long requestEpoch) { return epoch == requestEpoch; }
}
