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

/** Stores the Link session encrypted under an Android Keystore AES key. */
final class KeystoreSessionStore {
    private static final String KEY_ALIAS = "agentmux-link-session";
    private static final String PREF_SESSION = "linkSession";
    private static final String PREF_IV = "linkSessionIv";
    private static final String PREF_BASE = "linkBase";

    private final SharedPreferences preferences;

    KeystoreSessionStore(SharedPreferences preferences) {
        this.preferences = preferences;
    }

    String baseUrl() {
        String value = preferences.getString(PREF_BASE, "");
        return value == null || value.isBlank() ? PublicLinkClient.DEFAULT_BASE : value;
    }

    String session() {
        try {
            String encrypted = preferences.getString(PREF_SESSION, "");
            String ivText = preferences.getString(PREF_IV, "");
            if (encrypted.isEmpty() || ivText.isEmpty()) return null;
            byte[] iv = android.util.Base64.decode(ivText, android.util.Base64.NO_WRAP);
            byte[] ciphertext = android.util.Base64.decode(encrypted, android.util.Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        } catch (Exception error) {
            return null;
        }
    }

    void save(String baseUrl, String session) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] ciphertext = cipher.doFinal(session.getBytes(StandardCharsets.UTF_8));
            preferences.edit()
                .putString(PREF_BASE, baseUrl)
                .putString(PREF_SESSION, android.util.Base64.encodeToString(ciphertext, android.util.Base64.NO_WRAP))
                .putString(PREF_IV, android.util.Base64.encodeToString(cipher.getIV(), android.util.Base64.NO_WRAP))
                .apply();
        } catch (Exception ignored) {
            // A device without Keystore keeps no session; the user logs in again.
        }
    }

    void clear() {
        preferences.edit().remove(PREF_SESSION).remove(PREF_IV).apply();
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        SecretKey existing = store.getKey(KEY_ALIAS, null);
        if (existing != null) return existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }
}
