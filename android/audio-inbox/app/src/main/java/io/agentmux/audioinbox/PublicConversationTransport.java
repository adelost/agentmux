package io.agentmux.audioinbox;

import java.io.File;

/**
 * WHAT: Maps the authenticated public mailbox client onto the conversation port.
 * WHY: Keeps Internet transport and Tailscale discovery out of the Compose surface.
 */
final class PublicConversationTransport implements ConversationTransport {
    static final long REPLY_TIMEOUT_MS = 20 * 60_000L;

    interface Client {
        String send(String clientMessageId, String target, String text) throws Exception;
        String sendVoice(String clientMessageId, String target, File audio) throws Exception;
        String awaitReply(String clientMessageId, long timeoutMs) throws Exception;
    }

    private final KeystoreSessionStore sessions;
    private final Client injected;

    PublicConversationTransport(KeystoreSessionStore sessions) {
        this.sessions = sessions;
        this.injected = null;
    }

    PublicConversationTransport(Client injected) {
        this.sessions = null;
        this.injected = injected;
    }

    @Override
    public String transportId() {
        return "public-link";
    }

    @Override
    public boolean supports(ConversationTarget target) {
        return target != null
            && target.kind == ConversationTarget.Kind.PUBLIC
            && target.available()
            && (injected != null || sessions.session() != null);
    }

    @Override
    public Accepted durableAccept(
        String turnId,
        ConversationTarget target,
        String text,
        File audio
    ) throws Exception {
        Client client = client();
        String wireTarget = "_windows_".equals(target.id) ? "windows" : target.id;
        if (audio == null) client.send(turnId, wireTarget, text);
        else client.sendVoice(turnId, wireTarget, audio);
        String visible = audio == null ? text : "Voice message";
        return new Accepted(visible, turnId, "");
    }

    @Override
    public Reply awaitReply(
        String turnId,
        ConversationTarget target,
        Accepted accepted
    ) throws Exception {
        return new Reply(target.id, client().awaitReply(turnId, REPLY_TIMEOUT_MS));
    }

    private Client client() {
        if (injected != null) return injected;
        String session = sessions.session();
        if (session == null) throw new IllegalStateException("public-link-login-required");
        return new PublicLinkClient(sessions.baseUrl(), session);
    }
}
