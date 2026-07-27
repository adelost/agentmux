package io.agentmux.audioinbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.File;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public class ConversationControllerConcurrencyTest {
    @Test
    public void heldReplyWaitsNeverBlockTheFifthDurableAcceptance() throws Exception {
        CountDownLatch releaseReplies = new CountDownLatch(1);
        CountDownLatch fourWaiting = new CountDownLatch(4);
        CountDownLatch fiveAccepted = new CountDownLatch(5);
        AtomicInteger failures = new AtomicInteger();
        ConversationTransport transport = new ConversationTransport() {
            public String transportId() { return "fake"; }
            public boolean supports(ConversationTarget target) { return true; }
            public Accepted durableAccept(
                String turnId,
                ConversationTarget target,
                String text,
                File audio
            ) {
                return new Accepted(text, turnId, "");
            }
            public Reply awaitReply(
                String turnId,
                ConversationTarget target,
                Accepted accepted
            ) throws Exception {
                if (!turnId.equals("turn-5")) fourWaiting.countDown();
                releaseReplies.await(5, TimeUnit.SECONDS);
                return new Reply(target.id, "reply");
            }
        };
        ConversationController.Listener listener = new ConversationController.Listener() {
            public void onSending(String id, ConversationTarget target, String draft) {}
            public void onAccepted(String id, ConversationTarget target, String text) {
                fiveAccepted.countDown();
            }
            public void onReply(String id, ConversationTarget target, String actual, String text) {}
            public void onDeliveryFailure(String id, ConversationTarget target, String message) {
                failures.incrementAndGet();
            }
            public void onReplyFailure(String id, ConversationTarget target, String message) {
                failures.incrementAndGet();
            }
        };
        ConversationController controller = new ConversationController(
            Runnable::run,
            List.of(transport),
            listener
        );
        ConversationTarget target = new ConversationTarget(
            "lsrc:3", "lsrc:3", ConversationTarget.Kind.AGENT,
            "http://127.0.0.1", "1234567890", "lsrc", 3
        );

        for (int index = 1; index <= 4; index++) {
            assertTrue(controller.sendText(target, "message", "turn-" + index));
        }
        assertTrue(fourWaiting.await(2, TimeUnit.SECONDS));
        assertTrue(controller.sendText(target, "fifth", "turn-5"));
        assertTrue("fifth send reached durable acceptance", fiveAccepted.await(2, TimeUnit.SECONDS));
        assertEquals(0, failures.get());

        releaseReplies.countDown();
        controller.close();
    }

    @Test
    public void replyWaitConcurrencyIsBoundedWhileEveryAcceptanceLaneRemainsLive()
        throws Exception {
        int turns = ConversationController.REPLY_WORKERS * 2;
        CountDownLatch accepted = new CountDownLatch(turns);
        CountDownLatch saturated = new CountDownLatch(ConversationController.REPLY_WORKERS);
        CountDownLatch releaseReplies = new CountDownLatch(1);
        AtomicInteger activeReplies = new AtomicInteger();
        AtomicInteger peakReplies = new AtomicInteger();
        ConversationTransport transport = new ConversationTransport() {
            public String transportId() { return "bounded-fake"; }
            public boolean supports(ConversationTarget target) { return true; }
            public Accepted durableAccept(
                String turnId,
                ConversationTarget target,
                String text,
                File audio
            ) {
                return new Accepted(text, turnId, "");
            }
            public Reply awaitReply(
                String turnId,
                ConversationTarget target,
                Accepted result
            ) throws Exception {
                int current = activeReplies.incrementAndGet();
                peakReplies.accumulateAndGet(current, Math::max);
                saturated.countDown();
                try {
                    releaseReplies.await(5, TimeUnit.SECONDS);
                    return new Reply(target.id, "reply");
                } finally {
                    activeReplies.decrementAndGet();
                }
            }
        };
        ConversationController.Listener listener = new ConversationController.Listener() {
            public void onSending(String id, ConversationTarget target, String draft) {}
            public void onAccepted(String id, ConversationTarget target, String text) {
                accepted.countDown();
            }
            public void onReply(String id, ConversationTarget target, String actual, String text) {}
            public void onDeliveryFailure(String id, ConversationTarget target, String message) {}
            public void onReplyFailure(String id, ConversationTarget target, String message) {}
        };
        ConversationController controller = new ConversationController(
            Runnable::run,
            List.of(transport),
            listener
        );
        ConversationTarget target = target();

        for (int index = 0; index < turns; index++) {
            assertTrue(controller.sendText(target, "message", "bounded-" + index));
        }

        assertTrue("every send reached durable acceptance", accepted.await(2, TimeUnit.SECONDS));
        assertTrue("reply lane reached its bound", saturated.await(2, TimeUnit.SECONDS));
        assertEquals(ConversationController.REPLY_WORKERS, peakReplies.get());
        releaseReplies.countDown();
        controller.close();
    }

    private static ConversationTarget target() {
        return new ConversationTarget(
            "lsrc:3", "lsrc:3", ConversationTarget.Kind.AGENT,
            "http://127.0.0.1", "1234567890", "lsrc", 3
        );
    }
}
