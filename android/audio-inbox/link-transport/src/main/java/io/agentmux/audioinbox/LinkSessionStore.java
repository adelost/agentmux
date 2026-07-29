package io.agentmux.audioinbox;

/**
 * Secure, durable session boundary shared by phone authentication and Wear handoff.
 * Implementations commit a complete credential set or preserve the old one.
 */
public interface LinkSessionStore extends LinkSessionSource {
    String identityId();
    String pendingVerifier();
    boolean replacePendingVerifier(String verifier);
    boolean saveSessionAndClearPending(
        LinkSessionCredentials credentials,
        String expectedVerifier
    );
    boolean replaceSession(LinkSessionCredentials credentials);
    void clear();

    default LinkSessionCredentials credentials() {
        String current = session();
        return current == null ? null : new LinkSessionCredentials(baseUrl(), current, identityId());
    }
}
