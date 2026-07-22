package io.agentmux.audioinbox;

final class ConversationTarget {
    enum Kind { AGENT, WINDOWS }

    final String id;
    final String label;
    final Kind kind;
    final String serverUrl;
    final String audioTarget;
    final String agent;
    final int pane;

    ConversationTarget(
        String id,
        String label,
        Kind kind,
        String serverUrl,
        String audioTarget,
        String agent,
        int pane
    ) {
        this.id = id;
        this.label = label;
        this.kind = kind;
        this.serverUrl = serverUrl;
        this.audioTarget = audioTarget;
        this.agent = agent;
        this.pane = pane;
    }

    boolean available() {
        return ServerDiscovery.isAllowedServer(serverUrl)
            && (kind == Kind.WINDOWS || (agent != null && pane >= 0 && audioTarget != null));
    }
}
