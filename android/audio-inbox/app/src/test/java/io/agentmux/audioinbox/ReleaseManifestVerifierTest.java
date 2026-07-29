package io.agentmux.audioinbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import net.i2p.crypto.eddsa.EdDSAEngine;
import net.i2p.crypto.eddsa.EdDSAPublicKey;
import net.i2p.crypto.eddsa.KeyPairGenerator;
import net.i2p.crypto.eddsa.spec.EdDSAParameterSpec;
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveSpec;
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveTable;
import net.i2p.crypto.eddsa.spec.EdDSAPrivateKeySpec;

import org.json.JSONObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;

public class ReleaseManifestVerifierTest {
    @Test
    public void nodePublisherAndPinnedAndroidVerifierAgree() throws Exception {
        String manifest = """
            {"schemaVersion":1,"packageName":"io.agentmux.audioinbox","versionCode":3,"versionName":"1.1.1","apk":{"url":"https://link.v1d.io/releases/agentmux-link/phone/app-3.apk","sizeBytes":8998355,"sha256":"4f2dcf192bc98f4dfd5fcfd20907d475e1c85f6d5feb4b00d5676137d03bf0d3"},"changelog":"Polished CircleKit UI, signed automatic updates, safer playback, and improved launcher identity","createdAt":"2026-07-29T10:00:19.571Z","expiresAt":"2026-08-12T10:00:19.571Z"}
            """;
        String signature =
            "JJRXRoO/P9OWeotObksldA20BWdonYwtW1mlsG+l2YraIvwQIugtlNi/x3L1COCMPGGALQKeTp5I+0JuHfC3BA==";

        ReleaseCandidate candidate = ReleaseManifestVerifier.verify(
            manifest,
            signature,
            Instant.parse("2026-07-29T10:05:00Z").toEpochMilli()
        );

        assertEquals(3, candidate.versionCode());
    }

    @Test
    public void canonicalUrlsUseThePublisherSlashForm() throws Exception {
        JSONObject payload = new JSONObject()
            .put("url", "https://link.v1d.io/releases/app.apk")
            .put("label", "quote\"slash\\line\n");

        assertEquals(
            "{\"label\":\"quote\\\"slash\\\\line\\n\",\"url\":\"https:\\/\\/link.v1d.io\\/releases\\/app.apk\"}",
            CanonicalJson.encode(payload)
        );
    }

    @Test
    public void validCanonicalManifestPassesAndTamperOrStaleFailsClosed() throws Exception {
        EdDSANamedCurveSpec spec = EdDSANamedCurveTable.getByName("Ed25519");
        KeyPairGenerator generator = new KeyPairGenerator();
        generator.initialize(spec, new SecureRandom());
        KeyPair pair = generator.generateKeyPair();
        long now = Instant.parse("2026-07-27T20:00:00Z").toEpochMilli();
        JSONObject payload = payload();
        String manifest = payload.toString(2);
        String signature = sign(pair, payload, spec);
        byte[] publicKey = ((EdDSAPublicKey) pair.getPublic()).getAbyte();

        ReleaseCandidate candidate =
            ReleaseManifestVerifier.verify(manifest, signature, now, publicKey);
        assertEquals(2, candidate.versionCode());

        payload.put("versionCode", 3);
        assertThrows(SecurityException.class, () ->
            ReleaseManifestVerifier.verify(payload.toString(), signature, now, publicKey));
        assertThrows(SecurityException.class, () ->
            ReleaseManifestVerifier.verify(manifest, signature, now + 15L * 24 * 3600_000, publicKey));
    }

    @Test
    public void wrongHostAndUnknownFieldsFailEvenWhenSigned() throws Exception {
        EdDSANamedCurveSpec spec = EdDSANamedCurveTable.getByName("Ed25519");
        KeyPairGenerator generator = new KeyPairGenerator();
        generator.initialize(spec, new SecureRandom());
        KeyPair pair = generator.generateKeyPair();
        JSONObject payload = payload();
        payload.getJSONObject("apk").put("url", "https://link.v1d.io.evil.test/app-2.apk");
        byte[] publicKey = ((EdDSAPublicKey) pair.getPublic()).getAbyte();

        assertThrows(SecurityException.class, () -> ReleaseManifestVerifier.verify(
            payload.toString(),
            sign(pair, payload, spec),
            Instant.parse("2026-07-27T20:00:00Z").toEpochMilli(),
            publicKey
        ));

        JSONObject extra = payload();
        extra.put("notes", "not part of schema v1");
        assertThrows(SecurityException.class, () -> ReleaseManifestVerifier.verify(
            extra.toString(),
            sign(pair, extra, spec),
            Instant.parse("2026-07-27T20:00:00Z").toEpochMilli(),
            publicKey
        ));
    }

    private static JSONObject payload() throws Exception {
        return new JSONObject()
            .put("schemaVersion", 1)
            .put("packageName", "io.agentmux.audioinbox")
            .put("versionCode", 2)
            .put("versionName", "1.1.0")
            .put("apk", new JSONObject()
                .put("url", "https://link.v1d.io/releases/agentmux-link/phone/app-2.apk")
                .put("sizeBytes", 4_000_000)
                .put("sha256", "a".repeat(64)))
            .put("changelog", "Stop and concurrent turns")
            .put("createdAt", "2026-07-27T19:00:00Z")
            .put("expiresAt", "2026-08-10T19:00:00Z");
    }

    private static String sign(
        KeyPair pair,
        JSONObject payload,
        EdDSAParameterSpec spec
    ) throws Exception {
        EdDSAEngine engine = new EdDSAEngine(MessageDigest.getInstance(spec.getHashAlgorithm()));
        engine.initSign(pair.getPrivate());
        engine.update(CanonicalJson.encode(payload).getBytes(StandardCharsets.UTF_8));
        return Base64.getEncoder().encodeToString(engine.sign());
    }
}
