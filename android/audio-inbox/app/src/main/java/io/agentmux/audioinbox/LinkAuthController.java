package io.agentmux.audioinbox;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Google login flow for the public Link: Custom Tab, deep link, exchange. */
final class LinkAuthController {
    interface Listener {
        void onLogin(String session);
        void onError(String message);
    }

    private final Activity activity;
    private final KeystoreSessionStore store;
    private final Listener listener;
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private String pendingVerifier;

    LinkAuthController(Activity activity, KeystoreSessionStore store, Listener listener) {
        this.activity = activity;
        this.store = store;
        this.listener = listener;
    }

    boolean loggedIn() {
        return store.session() != null;
    }

    String session() {
        return store.session();
    }

    void beginLogin() {
        pendingVerifier = PublicLinkClient.generateVerifier();
        String challenge = PublicLinkClient.pkceChallenge(pendingVerifier);
        String url = PublicLinkClient.authStartUrl(store.baseUrl(), challenge);
        activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
    }

    /** Handles agentmux://auth?code=... deep links. Returns true when consumed. */
    boolean handleDeepLink(Uri uri) {
        if (uri == null || !"agentmux".equals(uri.getScheme()) || !"auth".equals(uri.getHost())) return false;
        String code = uri.getQueryParameter("code");
        if (code == null || pendingVerifier == null) {
            listener.onError("login code missing; start login again");
            return true;
        }
        work.execute(() -> {
            try {
                String session = PublicLinkClient.exchange(store.baseUrl(), code, pendingVerifier);
                store.save(store.baseUrl(), session);
                activity.runOnUiThread(() -> listener.onLogin(session));
            } catch (Exception error) {
                String message = error.getMessage() == null ? "login failed" : error.getMessage();
                activity.runOnUiThread(() -> listener.onError(message));
            }
        });
        return true;
    }

    void logout() {
        String session = store.session();
        if (session != null) {
            String base = store.baseUrl();
            work.execute(() -> new PublicLinkClient(base, session).revoke());
        }
        store.clear();
    }

    void close() {
        work.shutdownNow();
    }
}
