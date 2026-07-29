package io.agentmux.audioinbox;

import net.i2p.crypto.eddsa.EdDSAEngine;
import net.i2p.crypto.eddsa.EdDSAPublicKey;
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveTable;
import net.i2p.crypto.eddsa.spec.EdDSAParameterSpec;
import net.i2p.crypto.eddsa.spec.EdDSAPublicKeySpec;

import org.json.JSONObject;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;

/** Fail-closed parser for the detached Ed25519 phone release manifest. */
final class ReleaseManifestVerifier {
    private static final String PUBLIC_KEY_DER =
        "MCowBQYDK2VwAyEA248dCHD6+pv8du7D2m7SdaseJukMbICGiygzgD9HUbM=";
    private static final Set<String> PAYLOAD_KEYS = Set.of(
        "schemaVersion", "packageName", "versionCode", "versionName",
        "apk", "changelog", "createdAt", "expiresAt"
    );
    private static final Set<String> APK_KEYS = Set.of("url", "sizeBytes", "sha256");
    private static final long MAX_APK_BYTES = 150L * 1024L * 1024L;
    private static final long MAX_VALIDITY_MS = 14L * 24L * 60L * 60L * 1000L;

    private ReleaseManifestVerifier() {}

    static ReleaseCandidate verify(String manifest, String signature, long nowMs) throws Exception {
        byte[] encoded = Base64.getDecoder().decode(PUBLIC_KEY_DER);
        if (encoded.length != 44) throw new SecurityException("pinned release key is invalid");
        return verify(manifest, signature, nowMs, Arrays.copyOfRange(encoded, 12, 44));
    }

    static ReleaseCandidate verify(
        String manifest,
        String signature,
        long nowMs,
        byte[] rawPublicKey
    ) throws Exception {
        if (manifest == null || manifest.getBytes(StandardCharsets.UTF_8).length > 64 * 1024) {
            throw new SecurityException("release manifest is oversized");
        }
        JSONObject payload = new JSONObject(manifest);
        requireExactKeys(payload, PAYLOAD_KEYS);
        byte[] canonical = CanonicalJson.encode(payload).getBytes(StandardCharsets.UTF_8);
        byte[] signatureBytes = Base64.getDecoder().decode(signature.trim());
        if (!verifyEd25519(rawPublicKey, canonical, signatureBytes)) {
            throw new SecurityException("release manifest signature mismatch");
        }
        if (payload.getInt("schemaVersion") != 1
            || !"io.agentmux.audioinbox".equals(payload.getString("packageName"))) {
            throw new SecurityException("release identity mismatch");
        }
        int versionCode = payload.getInt("versionCode");
        String versionName = payload.getString("versionName");
        if (versionCode <= 0 || !versionName.matches("^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$")) {
            throw new SecurityException("release version is invalid");
        }
        JSONObject apk = payload.getJSONObject("apk");
        requireExactKeys(apk, APK_KEYS);
        String apkUrl = apk.getString("url");
        if (!safeReleaseUrl(apkUrl)) throw new SecurityException("unsafe release APK URL");
        long size = apk.getLong("sizeBytes");
        String sha = apk.getString("sha256");
        if (size <= 0 || size > MAX_APK_BYTES || !sha.matches("^[0-9a-f]{64}$")) {
            throw new SecurityException("release APK metadata is invalid");
        }
        String changelog = payload.getString("changelog").trim();
        if (changelog.length() > 600) throw new SecurityException("release changelog is oversized");
        long created = Instant.parse(payload.getString("createdAt")).toEpochMilli();
        long expires = Instant.parse(payload.getString("expiresAt")).toEpochMilli();
        if (created > nowMs + 5 * 60_000L || expires <= nowMs
            || expires <= created || expires - created > MAX_VALIDITY_MS) {
            throw new SecurityException("release manifest is stale");
        }
        return new ReleaseCandidate(
            versionCode, versionName, apkUrl, size, sha, changelog, created, expires
        );
    }

    private static boolean verifyEd25519(byte[] rawKey, byte[] message, byte[] signature)
        throws Exception {
        if (rawKey.length != 32 || signature.length != 64) return false;
        EdDSAParameterSpec spec = EdDSANamedCurveTable.getByName("Ed25519");
        EdDSAPublicKey key = new EdDSAPublicKey(new EdDSAPublicKeySpec(rawKey, spec));
        EdDSAEngine engine = new EdDSAEngine(MessageDigest.getInstance(spec.getHashAlgorithm()));
        engine.initVerify(key);
        engine.update(message);
        return engine.verify(signature);
    }

    private static void requireExactKeys(JSONObject object, Set<String> expected) {
        Set<String> actual = new HashSet<>();
        object.keys().forEachRemaining(actual::add);
        if (!actual.equals(expected)) throw new SecurityException("release manifest shape mismatch");
    }

    private static boolean safeReleaseUrl(String raw) {
        try {
            URI uri = URI.create(raw);
            String path = uri.getPath();
            String fileName = path.substring(path.lastIndexOf('/') + 1);
            return LinkReleaseProducts.INSTANCE.getPHONE().getAssetUrlPolicy().allows(raw)
                && fileName.matches("^app-[1-9]\\d*\\.apk$");
        } catch (Exception ignored) {
            return false;
        }
    }
}
