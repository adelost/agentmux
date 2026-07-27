package io.agentmux.audioinbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayDeque;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.TimeUnit;

public class LinkAuthControllerTest {
    @Test
    public void processRecreationUsesThePersistedVerifierAndSuccessClearsIt() {
        FakeStore store = new FakeStore();
        FakeClient client = new FakeClient("verifier-one");
        FakeHost firstHost = new FakeHost();
        LinkAuthController first = controller(firstHost, store, client, new RecordingListener());

        first.beginLogin();
        first.close();

        assertEquals("verifier-one", store.pendingVerifier());
        assertFalse(firstHost.openedUrl.contains("verifier-one"));

        RecordingListener listener = new RecordingListener();
        LinkAuthController recreated =
            controller(new FakeHost(), store, client, listener);
        assertTrue(recreated.handleCallback("agentmux", "auth", "code-one"));

        assertEquals("verifier-one", client.exchangedVerifier);
        assertEquals("session-one", store.session());
        assertNull(store.pendingVerifier());
        assertEquals("session-one", listener.login);
        assertNull(listener.error);
        recreated.close();
    }

    @Test
    public void failedExchangeKeepsTheVerifierForALocalRetry() {
        FakeStore store = new FakeStore();
        FakeClient client = new FakeClient("verifier-one");
        LinkAuthController first =
            controller(new FakeHost(), store, client, new RecordingListener());
        first.beginLogin();
        first.close();
        client.exchangeFailure = new IllegalStateException("network unavailable");

        RecordingListener listener = new RecordingListener();
        LinkAuthController recreated =
            controller(new FakeHost(), store, client, listener);
        recreated.handleCallback("agentmux", "auth", "code-one");

        assertEquals("verifier-one", store.pendingVerifier());
        assertNull(store.session());
        assertNull(listener.login);
        assertEquals("network unavailable", listener.error);
        recreated.close();
    }

    @Test
    public void aNewLoginAtomicallyReplacesTheOlderPendingVerifier() {
        FakeStore store = new FakeStore();
        FakeClient client = new FakeClient("verifier-one", "verifier-two");
        LinkAuthController controller =
            controller(new FakeHost(), store, client, new RecordingListener());

        controller.beginLogin();
        controller.beginLogin();

        assertEquals("verifier-two", store.pendingVerifier());
        controller.close();
    }

    @Test
    public void sessionPersistenceFailureNeverReportsLoginOrBurnsPendingState() {
        FakeStore store = new FakeStore();
        store.failSessionSave = true;
        FakeClient client = new FakeClient("verifier-one");
        RecordingListener listener = new RecordingListener();
        LinkAuthController controller =
            controller(new FakeHost(), store, client, listener);

        controller.beginLogin();
        controller.handleCallback("agentmux", "auth", "code-one");

        assertNull(listener.login);
        assertEquals("secure session save failed", listener.error);
        assertNull(store.session());
        assertEquals("verifier-one", store.pendingVerifier());
        controller.close();
    }

    private static LinkAuthController controller(
        FakeHost host,
        FakeStore store,
        FakeClient client,
        RecordingListener listener
    ) {
        return new LinkAuthController(host, store, client, listener, new DirectExecutor());
    }

    private static final class FakeHost implements LinkAuthController.Host {
        String openedUrl = "";

        public void open(String url) {
            openedUrl = url;
        }

        public void onUi(Runnable operation) {
            operation.run();
        }
    }

    private static final class FakeStore implements LinkAuthController.StateStore {
        String session;
        String pending;
        boolean failSessionSave;

        public String baseUrl() {
            return PublicLinkClient.DEFAULT_BASE;
        }

        public String session() {
            return session;
        }

        public String pendingVerifier() {
            return pending;
        }

        public boolean replacePendingVerifier(String verifier) {
            pending = verifier;
            return true;
        }

        public boolean saveSessionAndClearPending(
            String baseUrl,
            String value,
            String expectedVerifier
        ) {
            if (failSessionSave || !expectedVerifier.equals(pending)) return false;
            session = value;
            pending = null;
            return true;
        }

        public void clear() {
            session = null;
            pending = null;
        }
    }

    private static final class FakeClient implements LinkAuthController.Client {
        final Queue<String> verifiers;
        String exchangedVerifier;
        RuntimeException exchangeFailure;

        FakeClient(String... verifiers) {
            this.verifiers = new ArrayDeque<>(List.of(verifiers));
        }

        public String generateVerifier() {
            return verifiers.remove();
        }

        public String challenge(String verifier) {
            return "opaque-challenge-" + verifier.charAt(verifier.length() - 1);
        }

        public String authStartUrl(String baseUrl, String challenge) {
            return baseUrl + "/auth/start?challenge=" + challenge;
        }

        public String exchange(String baseUrl, String code, String verifier) {
            exchangedVerifier = verifier;
            if (exchangeFailure != null) throw exchangeFailure;
            return "session-one";
        }

        public void revoke(String baseUrl, String session) {}
    }

    private static final class RecordingListener implements LinkAuthController.Listener {
        String login;
        String error;

        public void onLogin(String session) {
            login = session;
        }

        public void onError(String message) {
            error = message;
        }
    }

    private static final class DirectExecutor extends AbstractExecutorService {
        private boolean shutdown;

        public void shutdown() {
            shutdown = true;
        }

        public List<Runnable> shutdownNow() {
            shutdown = true;
            return List.of();
        }

        public boolean isShutdown() {
            return shutdown;
        }

        public boolean isTerminated() {
            return shutdown;
        }

        public boolean awaitTermination(long timeout, TimeUnit unit) {
            return shutdown;
        }

        public void execute(Runnable operation) {
            if (!shutdown) operation.run();
        }
    }
}
