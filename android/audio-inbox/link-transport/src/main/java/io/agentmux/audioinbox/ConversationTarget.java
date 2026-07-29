package io.agentmux.audioinbox;

public final class ConversationTarget {
    public enum Kind { AGENT, WINDOWS, PUBLIC }

    public final String id;
    public final String label;
    public final Kind kind;
    public final String serverUrl;
    public final String audioTarget;
    public final String agent;
    public final int pane;
    private final Boolean availabilityOverride;

    public ConversationTarget(
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

    public static ConversationTarget publicLink(String id, String label, boolean online) {
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

    public boolean available() {
        if (availabilityOverride != null) return availabilityOverride;
        return LinkUrlPolicy.isAllowedServer(serverUrl)
            && (kind == Kind.WINDOWS || (agent != null && pane >= 0 && audioTarget != null));
    }
}
