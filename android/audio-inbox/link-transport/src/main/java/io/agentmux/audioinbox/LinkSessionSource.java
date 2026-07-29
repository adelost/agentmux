package io.agentmux.audioinbox;

/** Secure session view shared by phone and Wear mailbox transports. */
public interface LinkSessionSource {
    String baseUrl();
    String session();
}
