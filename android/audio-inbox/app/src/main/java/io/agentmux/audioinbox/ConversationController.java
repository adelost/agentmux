package io.agentmux.audioinbox;

import android.app.Activity;

import java.io.File;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

final class ConversationController implements AutoCloseable {
    interface Listener {
        void onSending();
        void onTranscript(String text);
        void onReply(String text);
        void onFailure(String message);
    }

    private final Activity activity;
    private final String consumerId;
    private final Listener listener;
    private final ExecutorService turns = Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy = new AtomicBoolean();

    ConversationController(Activity activity, String consumerId, Listener listener) {
        this.activity = activity;
        this.consumerId = consumerId;
        this.listener = listener;
    }

    boolean isBusy() {
        return busy.get();
    }

    boolean sendText(ConversationTarget target, String text) {
        String clean = String.valueOf(text).trim();
        if (clean.isEmpty()) return false;
        return submit(target, clean, null, "text-" + UUID.randomUUID());
    }

    boolean sendAudio(ConversationTarget target, File audio, String turnId) {
        return audio != null && submit(target, null, audio, turnId);
    }

    private boolean submit(ConversationTarget target, String text, File audio, String turnId) {
        if (target == null || !target.available() || !busy.compareAndSet(false, true)) return false;
        activity.runOnUiThread(listener::onSending);
        turns.execute(() -> runTurn(target, text, audio, turnId));
        return true;
    }

    private void runTurn(ConversationTarget target, String text, File audio, String turnId) {
        try {
            AudioInboxHttpClient client = new AudioInboxHttpClient(target.serverUrl, consumerId);
            AudioInboxHttpClient.TurnResult sent = client.sendTurn(target, text, audio, turnId);
            String visibleUserText = sent.transcript.isEmpty() ? sent.sent : sent.transcript;
            activity.runOnUiThread(() -> listener.onTranscript(visibleUserText));
            String answer = sent.answer;
            if (answer.isEmpty() && target.kind == ConversationTarget.Kind.AGENT) {
                answer = client.awaitAgentReply(target, sent.replyPrompt);
            }
            if (answer.isEmpty()) throw new IllegalStateException("empty agent reply");
            String finalAnswer = answer;
            busy.set(false);
            activity.runOnUiThread(() -> listener.onReply(finalAnswer));
        } catch (Exception error) {
            String message = safeMessage(error);
            busy.set(false);
            activity.runOnUiThread(() -> listener.onFailure(message));
        } finally {
            if (audio != null) audio.delete();
        }
    }

    private static String safeMessage(Exception error) {
        String value = error.getMessage() == null ? "unknown error" : error.getMessage();
        value = value.replaceAll("[\\r\\n]+", " ").trim();
        return value.substring(0, Math.min(value.length(), 140));
    }

    @Override
    public void close() {
        turns.shutdownNow();
    }
}
