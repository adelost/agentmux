package io.agentmux.audioinbox;

/** Authenticated mailbox session transferred from phone to Wear. */
public record LinkSessionCredentials(
    String baseUrl,
    String session,
    String identityId
) {
    public LinkSessionCredentials {
        baseUrl = normalized(baseUrl, PublicLinkClient.DEFAULT_BASE);
        session = normalized(session, "");
        identityId = normalized(identityId, "");
        if (!LinkUrlPolicy.isAllowedServer(baseUrl)) {
            throw new IllegalArgumentException("invalid Link base URL");
        }
        if (session.isEmpty()) throw new IllegalArgumentException("session required");
    }

    private static String normalized(String value, String fallback) {
        String clean = value == null ? "" : value.trim();
        return (clean.isEmpty() ? fallback : clean).replaceAll("/+$", "");
    }
}
