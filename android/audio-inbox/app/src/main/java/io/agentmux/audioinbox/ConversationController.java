package io.agentmux.audioinbox;

import android.app.Activity;

import java.io.File;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class ConversationController implements AutoCloseable {
    static final int REPLY_WORKERS = 8;

    interface Listener {
        void onSending(String turnId, ConversationTarget target, String draft);
        void onAccepted(String turnId, ConversationTarget target, String visibleText);
        void onReply(String turnId, ConversationTarget target, String respondingTarget, String text);
        void onDeliveryFailure(String turnId, ConversationTarget target, String message);
        void onReplyFailure(String turnId, ConversationTarget target, String message);
    }

    interface UiDispatcher {
        void dispatch(Runnable operation);
    }

    private final UiDispatcher ui;
    private final Listener listener;
    private final ExecutorService accepts = Executors.newFixedThreadPool(4);
    private final ExecutorService replies = Executors.newFixedThreadPool(REPLY_WORKERS);
    private final List<ConversationTransport> transports;

    ConversationController(Activity activity, String consumerId, Listener listener) {
        this(activity::runOnUiThread, List.of(new TailnetConversationTransport(consumerId)), listener);
    }

    ConversationController(
        Activity activity,
        String consumerId,
        KeystoreSessionStore sessions,
        Listener listener
    ) {
        this(
            activity::runOnUiThread,
            List.of(
                new PublicConversationTransport(sessions),
                new TailnetConversationTransport(consumerId)
            ),
            listener
        );
    }

    ConversationController(
        UiDispatcher ui,
        List<ConversationTransport> transports,
        Listener listener
    ) {
        this.ui = ui;
        this.listener = listener;
        this.transports = List.copyOf(transports);
    }

    boolean sendText(ConversationTarget target, String text, String turnId) {
        String clean = String.valueOf(text).trim();
        if (clean.isEmpty()) return false;
        return submit(target, clean, null, turnId);
    }

    boolean sendAudio(ConversationTarget target, File audio, String turnId) {
        return audio != null && submit(target, null, audio, turnId);
    }

    private boolean submit(ConversationTarget target, String text, File audio, String turnId) {
        ConversationTransport transport = transports.stream()
            .filter(candidate -> candidate.supports(target))
            .findFirst()
            .orElse(null);
        if (transport == null || turnId == null || turnId.isBlank()) return false;
        String draft = text == null ? "" : text;
        ui.dispatch(() -> listener.onSending(turnId, target, draft));
        accepts.execute(() -> acceptTurn(transport, target, text, audio, turnId));
        return true;
    }

    private void acceptTurn(
        ConversationTransport transport,
        ConversationTarget target,
        String text,
        File audio,
        String turnId
    ) {
        try {
            ConversationTransport.Accepted accepted =
                transport.durableAccept(turnId, target, text, audio);
            ui.dispatch(() ->
                listener.onAccepted(turnId, target, accepted.visibleText()));
            replies.execute(() -> awaitReply(transport, target, turnId, accepted));
        } catch (Exception error) {
            String message = safeMessage(error);
            ui.dispatch(() -> listener.onDeliveryFailure(turnId, target, message));
        } finally {
            if (audio != null) audio.delete();
        }
    }

    private void awaitReply(
        ConversationTransport transport,
        ConversationTarget target,
        String turnId,
        ConversationTransport.Accepted accepted
    ) {
        try {
            ConversationTransport.Reply reply = transport.awaitReply(turnId, target, accepted);
            ui.dispatch(() ->
                listener.onReply(turnId, target, reply.respondingTarget(), reply.text()));
        } catch (Exception error) {
            String message = safeMessage(error);
            ui.dispatch(() -> listener.onReplyFailure(turnId, target, message));
        }
    }

    private static String safeMessage(Exception error) {
        String value = error.getMessage() == null ? "unknown error" : error.getMessage();
        value = value.replaceAll("[\\r\\n]+", " ").trim();
        return value.substring(0, Math.min(value.length(), 140));
    }

    @Override
    public void close() {
        accepts.shutdownNow();
        replies.shutdownNow();
    }
}
