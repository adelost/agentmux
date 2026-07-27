package io.agentmux.audioinbox;

import java.io.File;

/** Current private-tailnet adapter for the transport-neutral conversation UI. */
final class TailnetConversationTransport implements ConversationTransport {
    private final String consumerId;

    TailnetConversationTransport(String consumerId) {
        this.consumerId = consumerId;
    }

    @Override
    public String transportId() {
        return "tailnet";
    }

    @Override
    public boolean supports(ConversationTarget target) {
        return target != null
            && target.kind != ConversationTarget.Kind.PUBLIC
            && target.available();
    }

    @Override
    public Accepted durableAccept(
        String turnId,
        ConversationTarget target,
        String text,
        File audio
    ) throws Exception {
        AudioInboxHttpClient client = new AudioInboxHttpClient(target.serverUrl, consumerId);
        AudioInboxHttpClient.TurnResult sent = client.sendTurn(target, text, audio, turnId);
        String visible = sent.transcript.isEmpty() ? sent.sent : sent.transcript;
        return new Accepted(visible, sent.replyPrompt, sent.answer);
    }

    @Override
    public Reply awaitReply(
        String turnId,
        ConversationTarget target,
        Accepted accepted
    ) throws Exception {
        String answer = accepted.immediateReply();
        if (answer.isEmpty() && target.kind == ConversationTarget.Kind.AGENT) {
            AudioInboxHttpClient client = new AudioInboxHttpClient(target.serverUrl, consumerId);
            answer = client.awaitAgentReply(target, accepted.replyCursor());
        }
        if (answer.isEmpty()) throw new IllegalStateException("empty agent reply");
        return new Reply(target.id, answer);
    }
}
