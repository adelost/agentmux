package io.agentmux.audioinbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** Mattias 2026-09-15: DISCONNECTED appeared after replies and on every feed reconnect while Link kept working. */
public final class FeedConnectionReceiptsTest {
    @Test
    public void aFinishedReplyWithAnnouncementsOffSettlesAsOffNotDisconnected() {
        assertEquals("Off", FeedConnectionReceipts.settled(false, false));
        assertEquals("Connected", FeedConnectionReceipts.settled(true, true));
        assertNull(FeedConnectionReceipts.settled(true, false));
    }

    @Test
    public void aFeedThatReconnectsWithinTheGraceIsNeverReported() {
        FeedConnectionReceipts receipts = new FeedConnectionReceipts(null, (receipt, connected) -> { });
        receipts.disconnected(1_000L);
        assertNull(receipts.outageReceipt(true, 1_000L + FeedConnectionReceipts.OUTAGE_GRACE_MS - 1));
        receipts.connected();
        assertNull(receipts.outageReceipt(false, 1_000L + FeedConnectionReceipts.OUTAGE_GRACE_MS));
    }

    @Test
    public void aSustainedOutageWithAnnouncementsOnIsReportedWithItsReason() {
        FeedConnectionReceipts receipts = new FeedConnectionReceipts(null, (receipt, connected) -> { });
        receipts.failed("feed HTTP 502");
        receipts.disconnected(1_000L);
        assertEquals("Disconnected: feed HTTP 502",
            receipts.outageReceipt(true, 1_000L + FeedConnectionReceipts.OUTAGE_GRACE_MS));
    }
}
