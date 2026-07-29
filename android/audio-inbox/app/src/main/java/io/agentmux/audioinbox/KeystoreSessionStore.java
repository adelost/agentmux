package io.agentmux.audioinbox;

import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * WHAT: Stores Link session and pending PKCE state under an Android Keystore key.
 * WHY: Lets authentication survive process recreation without exposing bearer material.
 */
final class KeystoreSessionStore implements LinkAuthController.StateStore, LinkSessionSource {
    private static final String KEY_ALIAS = "agentmux-link-session";
    private static final String PREF_SESSION = "linkSession";
    private static final String PREF_IV = "linkSessionIv";
    private static final String PREF_BASE = "linkBase";
    private static final String PREF_PENDING = "linkPendingVerifier";
    private static final String PREF_PENDING_IV = "linkPendingVerifierIv";

    interface Codec {
        EncryptedValue encrypt(String value) throws Exception;
        String decrypt(EncryptedValue value) throws Exception;
    }

    record EncryptedValue(String ciphertext, String iv) {}

    private final SharedPreferences preferences;
    private final Codec codec;

    KeystoreSessionStore(SharedPreferences preferences) {
        this(preferences, new AndroidKeystoreCodec());
    }

    KeystoreSessionStore(SharedPreferences preferences, Codec codec) {
        this.preferences = preferences;
        this.codec = codec;
    }

    @Override
    public String baseUrl() {
        String value = preferences.getString(PREF_BASE, "");
        return value == null || value.isBlank() ? PublicLinkClient.DEFAULT_BASE : value;
    }

    @Override
    public String session() {
        return readEncrypted(PREF_SESSION, PREF_IV);
    }

    @Override
    public String pendingVerifier() {
        return readEncrypted(PREF_PENDING, PREF_PENDING_IV);
    }

    @Override
    public synchronized boolean replacePendingVerifier(String verifier) {
        try {
            EncryptedValue value = codec.encrypt(verifier);
            return preferences.edit()
                .putString(PREF_PENDING, value.ciphertext())
                .putString(PREF_PENDING_IV, value.iv())
                .commit();
        } catch (Exception error) {
            return false;
        }
    }

    @Override
    public synchronized boolean saveSessionAndClearPending(
        String baseUrl,
        String session,
        String expectedVerifier
    ) {
        try {
            if (!expectedVerifier.equals(pendingVerifier())) return false;
            EncryptedValue value = codec.encrypt(session);
            return preferences.edit()
                .putString(PREF_BASE, baseUrl)
                .putString(PREF_SESSION, value.ciphertext())
                .putString(PREF_IV, value.iv())
                .remove(PREF_PENDING)
                .remove(PREF_PENDING_IV)
                .commit();
        } catch (Exception error) {
            return false;
        }
    }

    @Override
    public void clear() {
        preferences.edit()
            .remove(PREF_SESSION)
            .remove(PREF_IV)
            .remove(PREF_PENDING)
            .remove(PREF_PENDING_IV)
            .apply();
    }

    private String readEncrypted(String valueKey, String ivKey) {
        try {
            String encrypted = preferences.getString(valueKey, "");
            String iv = preferences.getString(ivKey, "");
            if (encrypted == null || encrypted.isEmpty() || iv == null || iv.isEmpty()) return null;
            return codec.decrypt(new EncryptedValue(encrypted, iv));
        } catch (Exception error) {
            return null;
        }
    }

    private static final class AndroidKeystoreCodec implements Codec {
        @Override
        public EncryptedValue encrypt(String value) throws Exception {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            return new EncryptedValue(
                android.util.Base64.encodeToString(ciphertext, android.util.Base64.NO_WRAP),
                android.util.Base64.encodeToString(cipher.getIV(), android.util.Base64.NO_WRAP)
            );
        }

        @Override
        public String decrypt(EncryptedValue value) throws Exception {
            byte[] iv = android.util.Base64.decode(value.iv(), android.util.Base64.NO_WRAP);
            byte[] ciphertext =
                android.util.Base64.decode(value.ciphertext(), android.util.Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        }

        private SecretKey key() throws Exception {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            SecretKey existing = (SecretKey) store.getKey(KEY_ALIAS, null);
            if (existing != null) return existing;
            KeyGenerator generator =
                KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
            return generator.generateKey();
        }
    }
}
