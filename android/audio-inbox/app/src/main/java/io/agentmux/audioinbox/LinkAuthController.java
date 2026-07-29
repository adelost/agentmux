package io.agentmux.audioinbox;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * WHAT: Coordinates restart-safe Public Link PKCE login and session persistence.
 * WHY: Keeps process recreation from invalidating a legitimate auth callback.
 */
final class LinkAuthController {
    interface Listener {
        void onLogin(LinkSessionCredentials credentials);
        void onError(String message);
    }

    interface Client {
        String generateVerifier();
        String challenge(String verifier);
        String authStartUrl(String baseUrl, String challenge);
        LinkSessionCredentials exchange(
            String baseUrl,
            String code,
            String verifier
        ) throws Exception;
        void revoke(String baseUrl, String session);
    }

    interface Host {
        void open(String url);
        void onUi(Runnable operation);
    }

    private final Host host;
    private final LinkSessionStore store;
    private final Client client;
    private final Listener listener;
    private final ExecutorService work;

    LinkAuthController(Activity activity, KeystoreSessionStore store, Listener listener) {
        this(
            new Host() {
                public void open(String url) {
                    activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                }
                public void onUi(Runnable operation) {
                    activity.runOnUiThread(operation);
                }
            },
            store,
            new PlatformClient(),
            listener,
            Executors.newSingleThreadExecutor()
        );
    }

    LinkAuthController(
        Host host,
        LinkSessionStore store,
        Client client,
        Listener listener,
        ExecutorService work
    ) {
        this.host = host;
        this.store = store;
        this.client = client;
        this.listener = listener;
        this.work = work;
    }

    boolean loggedIn() {
        return store.session() != null;
    }

    String session() {
        return store.session();
    }

    void beginLogin() {
        String verifier = client.generateVerifier();
        if (!store.replacePendingVerifier(verifier)) {
            notifyError("secure login state could not be saved");
            return;
        }
        String challenge = client.challenge(verifier);
        host.open(client.authStartUrl(store.baseUrl(), challenge));
    }

    /** Handles agentmux://auth?code=... deep links. Returns true when consumed. */
    boolean handleDeepLink(Uri uri) {
        if (uri == null) return false;
        return handleCallback(uri.getScheme(), uri.getHost(), uri.getQueryParameter("code"));
    }

    boolean handleCallback(String scheme, String hostName, String code) {
        if (!"agentmux".equals(scheme) || !"auth".equals(hostName)) return false;
        if (code == null || code.isBlank()) {
            listener.onError("login code missing; start login again");
            return true;
        }
        work.execute(() -> {
            String verifier = store.pendingVerifier();
            if (verifier == null) {
                notifyError("login state missing; start login again");
                return;
            }
            try {
                String baseUrl = store.baseUrl();
                LinkSessionCredentials credentials =
                    client.exchange(baseUrl, code, verifier);
                if (!store.saveSessionAndClearPending(credentials, verifier)) {
                    notifyError("secure session save failed");
                    return;
                }
                host.onUi(() -> listener.onLogin(credentials));
            } catch (Exception error) {
                String message = error.getMessage() == null ? "login failed" : error.getMessage();
                notifyError(message);
            }
        });
        return true;
    }

    void logout() {
        String session = store.session();
        if (session != null) {
            String base = store.baseUrl();
            work.execute(() -> client.revoke(base, session));
        }
        store.clear();
    }

    void close() {
        work.shutdownNow();
    }

    private void notifyError(String message) {
        host.onUi(() -> listener.onError(message));
    }

    private static final class PlatformClient implements Client {
        public String generateVerifier() {
            return PublicLinkClient.generateVerifier();
        }

        public String challenge(String verifier) {
            return PublicLinkClient.pkceChallenge(verifier);
        }

        public String authStartUrl(String baseUrl, String challenge) {
            return PublicLinkClient.authStartUrl(baseUrl, challenge);
        }

        public LinkSessionCredentials exchange(
            String baseUrl,
            String code,
            String verifier
        ) throws Exception {
            return PublicLinkClient.exchange(baseUrl, code, verifier);
        }

        public void revoke(String baseUrl, String session) {
            new PublicLinkClient(baseUrl, session).revoke();
        }
    }
}
