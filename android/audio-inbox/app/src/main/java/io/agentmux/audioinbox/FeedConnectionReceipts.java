package io.agentmux.audioinbox;

import android.os.Handler;
import android.os.SystemClock;
import java.util.function.BooleanSupplier;

/**
 * WHAT: The announcement feed's receipt after audio settles, and when a lost feed is worth reporting.
 * WHY: With announcements off the feed never runs, so "Disconnected" was a false alarm after every reply; and a
 * feed that reconnects within seconds is not an outage (Mattias 2026-09-15, DISCONNECTED "titt som tätt").
 */
final class FeedConnectionReceipts {
    static final long OUTAGE_GRACE_MS = 5_000L;

    interface Writer {
        void write(String receipt, boolean connected);
    }

    private final Handler main;
    private final Writer writer;
    private long disconnectedSinceMs = -1L;
    private String lastError = "";

    FeedConnectionReceipts(Handler main, Writer writer) {
        this.main = main;
        this.writer = writer;
    }

    /** The receipt once playback or a stop has settled; null while a running feed is away, which [lost] reports. */
    static String settled(boolean announcementsOn, boolean connected) {
        if (!announcementsOn) return "Off";
        return connected ? "Connected" : null;
    }

    void settle(boolean announcementsOn, boolean connected) {
        String receipt = settled(announcementsOn, connected);
        if (receipt != null) writer.write(receipt, connected);
    }

    void connected() {
        disconnectedSinceMs = -1L;
        lastError = "";
    }

    void failed(String detail) {
        lastError = detail == null ? "" : detail;
    }

    /** Main thread: the feed dropped; the receipt is written only if it is still down after the grace. */
    void lost(BooleanSupplier stillDown) {
        disconnected(SystemClock.elapsedRealtime());
        main.postDelayed(() -> {
            String receipt = outageReceipt(stillDown.getAsBoolean(), SystemClock.elapsedRealtime());
            if (receipt != null) writer.write(receipt, false);
        }, OUTAGE_GRACE_MS);
    }

    void disconnected(long nowMs) {
        if (disconnectedSinceMs < 0) disconnectedSinceMs = nowMs;
    }

    /** Null while the feed is up or only briefly away; the Disconnected receipt once the outage outlasts the grace. */
    String outageReceipt(boolean stillDown, long nowMs) {
        if (!stillDown || disconnectedSinceMs < 0 || nowMs - disconnectedSinceMs < OUTAGE_GRACE_MS) return null;
        return lastError.isEmpty() ? "Disconnected" : "Disconnected: " + lastError;
    }
}
