package io.agentmux.audioinbox;

final class ConversationTarget {
    enum Kind { AGENT, WINDOWS, PUBLIC }

    final String id;
    final String label;
    final Kind kind;
    final String serverUrl;
    final String audioTarget;
    final String agent;
    final int pane;
    private final Boolean availabilityOverride;

    ConversationTarget(
        String id,
        String label,
        Kind kind,
        String serverUrl,
        String audioTarget,
        String agent,
        int pane
    ) {
        this(id, label, kind, serverUrl, audioTarget, agent, pane, null);
    }

    private ConversationTarget(
        String id,
        String label,
        Kind kind,
        String serverUrl,
        String audioTarget,
        String agent,
        int pane,
        Boolean availabilityOverride
    ) {
        this.id = id;
        this.label = label;
        this.kind = kind;
        this.serverUrl = serverUrl;
        this.audioTarget = audioTarget;
        this.agent = agent;
        this.pane = pane;
        this.availabilityOverride = availabilityOverride;
    }

    static ConversationTarget publicLink(String id, String label, boolean online) {
        return new ConversationTarget(
            id,
            label,
            Kind.PUBLIC,
            PublicLinkClient.DEFAULT_BASE,
            null,
            null,
            -1,
            online
        );
    }

    boolean available() {
        if (availabilityOverride != null) return availabilityOverride;
        return ServerDiscovery.isAllowedServer(serverUrl)
            && (kind == Kind.WINDOWS || (agent != null && pane >= 0 && audioTarget != null));
    }
}
