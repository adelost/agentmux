package io.agentmux.audioinbox;

import java.io.File;

/**
 * Small client seam shared by tailnet and public Link transports.
 * Durable acceptance and reply waiting are deliberately separate so one slow
 * model turn never locks capture or another send.
 */
public interface ConversationTransport {
    record Accepted(String visibleText, String replyCursor, String immediateReply) {}
    record Reply(String respondingTarget, String text) {}

    String transportId();
    boolean supports(ConversationTarget target);

    Accepted durableAccept(
        String turnId,
        ConversationTarget target,
        String text,
        File audio
    ) throws Exception;

    Reply awaitReply(
        String turnId,
        ConversationTarget target,
        Accepted accepted
    ) throws Exception;
}
