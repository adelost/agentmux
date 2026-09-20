package io.agentmux.audioinbox;

public final class ConversationTarget {
    public enum Kind { AGENT, WINDOWS, PUBLIC }

    public static final class Model {
        public final String status;
        public final String observedModel;
        public final String observedEffort;
        public final String configuredModel;
        public final String configuredEffort;

        public Model(
            String status,
            String observedModel,
            String observedEffort,
            String configuredModel,
            String configuredEffort
        ) {
            this.status = switch (status) {
                case "current", "stale" -> status;
                default -> "unknown";
            };
            this.observedModel = observedModel;
            this.observedEffort = observedEffort;
            this.configuredModel = configuredModel;
            this.configuredEffort = configuredEffort;
        }

    }

    public final String id;
    public final String label;
    public final Kind kind;
    public final String serverUrl;
    public final String audioTarget;
    public final String agent;
    public final int pane;
    public final Model model;
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
        this(id, label, kind, serverUrl, audioTarget, agent, pane, null, null);
    }

    public ConversationTarget(
        String id,
        String label,
        Kind kind,
        String serverUrl,
        String audioTarget,
        String agent,
        int pane,
        Model model
    ) {
        this(id, label, kind, serverUrl, audioTarget, agent, pane, null, model);
    }

    private ConversationTarget(
        String id,
        String label,
        Kind kind,
        String serverUrl,
        String audioTarget,
        String agent,
        int pane,
        Boolean availabilityOverride,
        Model model
    ) {
        this.id = id;
        this.label = label;
        this.kind = kind;
        this.serverUrl = serverUrl;
        this.audioTarget = audioTarget;
        this.agent = agent;
        this.pane = pane;
        this.model = model;
        this.availabilityOverride = availabilityOverride;
    }

    public static ConversationTarget publicLink(String id, String label, boolean online) {
        return publicLink(id, label, online, null);
    }

    public static ConversationTarget publicLink(String id, String label, boolean online, Model model) {
        return new ConversationTarget(
            id,
            label,
            Kind.PUBLIC,
            PublicLinkClient.DEFAULT_BASE,
            null,
            null,
            -1,
            online,
            model
        );
    }

    public boolean available() {
        if (availabilityOverride != null) return availabilityOverride;
        return LinkUrlPolicy.isAllowedServer(serverUrl)
            && (kind == Kind.WINDOWS || (agent != null && pane >= 0 && audioTarget != null));
    }

    public ConversationTarget withModel(Model nextModel) {
        return new ConversationTarget(
            id,
            label,
            kind,
            serverUrl,
            audioTarget,
            agent,
            pane,
            availabilityOverride,
            nextModel
        );
    }
}
