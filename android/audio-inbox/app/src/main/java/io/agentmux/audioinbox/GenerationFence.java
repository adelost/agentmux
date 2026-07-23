package io.agentmux.audioinbox;

/**
 * Last-request-wins fence for async reply playback. Every new request takes
 * a fresh generation, invalidating all earlier pending work; close stale
 * proofs everything, so no callback ever fires after it.
 */
final class GenerationFence {
    private int generation;
    private boolean closed;

    /** Every play request takes the next generation; older work is stale. */
    synchronized int next() {
        return ++generation;
    }

    /** A deliberate stop invalidates pending work without closing. */
    synchronized void invalidate() {
        generation += 1;
    }

    synchronized void close() {
        closed = true;
        generation += 1;
    }

    synchronized boolean isStale(int expected) {
        return closed || expected != generation;
    }
}
