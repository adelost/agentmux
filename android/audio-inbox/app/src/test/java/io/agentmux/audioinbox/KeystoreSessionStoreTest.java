package io.agentmux.audioinbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class KeystoreSessionStoreTest {
    @Test
    public void pendingVerifierSurvivesRecreationAndIsReplacedWithoutPlaintext() {
        TestPreferences preferences = new TestPreferences();
        TestCodec codec = new TestCodec();
        KeystoreSessionStore first = new KeystoreSessionStore(preferences, codec);

        assertTrue(first.replacePendingVerifier("verifier-one"));
        KeystoreSessionStore recreated = new KeystoreSessionStore(preferences, codec);
        assertEquals("verifier-one", recreated.pendingVerifier());

        assertTrue(recreated.replacePendingVerifier("verifier-two"));
        assertEquals("verifier-two", first.pendingVerifier());
        assertFalse(preferences.data.containsValue("verifier-one"));
        assertFalse(preferences.data.containsValue("verifier-two"));
    }

    @Test
    public void sessionSaveAndPendingClearCommitAsOneExpectedVerifierTransition() {
        TestPreferences preferences = new TestPreferences();
        TestCodec codec = new TestCodec();
        KeystoreSessionStore store = new KeystoreSessionStore(preferences, codec);
        assertTrue(store.replacePendingVerifier("verifier-one"));

        assertFalse(store.saveSessionAndClearPending(
            credentials("session-one", "identity-one"),
            "stale-verifier"
        ));
        assertNull(store.session());
        assertEquals("verifier-one", store.pendingVerifier());

        assertTrue(store.saveSessionAndClearPending(
            credentials("session-one", "identity-one"),
            "verifier-one"
        ));
        assertEquals("session-one", store.session());
        assertEquals("identity-one", store.identityId());
        assertNull(store.pendingVerifier());
        assertFalse(preferences.data.containsValue("session-one"));
    }

    @Test
    public void handoffSessionRoundTripsAsOneCredentialSet() {
        TestPreferences preferences = new TestPreferences();
        TestCodec codec = new TestCodec();
        KeystoreSessionStore store = new KeystoreSessionStore(preferences, codec);

        assertTrue(store.replaceSession(credentials("session-wear", "identity-wear")));

        LinkSessionCredentials recreated =
            new KeystoreSessionStore(preferences, codec).credentials();
        assertEquals("session-wear", recreated.session());
        assertEquals("identity-wear", recreated.identityId());
        assertFalse(preferences.data.containsValue("session-wear"));
    }

    @Test
    public void codecFailureIsReportedInsteadOfClaimingPersistence() {
        KeystoreSessionStore store = new KeystoreSessionStore(
            new TestPreferences(),
            new KeystoreSessionStore.Codec() {
                public KeystoreSessionStore.EncryptedValue encrypt(String value)
                    throws Exception {
                    throw new Exception("keystore unavailable");
                }

                public String decrypt(KeystoreSessionStore.EncryptedValue value) {
                    return "";
                }
            }
        );

        assertFalse(store.replacePendingVerifier("verifier-one"));
    }

    private static final class TestCodec implements KeystoreSessionStore.Codec {
        public KeystoreSessionStore.EncryptedValue encrypt(String value) {
            return new KeystoreSessionStore.EncryptedValue(
                new StringBuilder(value).reverse().insert(0, "cipher:").toString(),
                "test-iv"
            );
        }

        public String decrypt(KeystoreSessionStore.EncryptedValue value) {
            String encoded = value.ciphertext().substring("cipher:".length());
            return new StringBuilder(encoded).reverse().toString();
        }
    }

    private static LinkSessionCredentials credentials(String session, String identity) {
        return new LinkSessionCredentials(PublicLinkClient.DEFAULT_BASE, session, identity);
    }
}
