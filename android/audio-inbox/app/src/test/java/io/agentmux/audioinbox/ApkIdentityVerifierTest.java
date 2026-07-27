package io.agentmux.audioinbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

import java.util.Set;

public class ApkIdentityVerifierTest {
    private static final String PACKAGE = "io.agentmux.audioinbox";
    private static final String SIGNER = "ABC123";
    private static final ReleaseCandidate RELEASE = new ReleaseCandidate(
        2, "1.1.0", "https://link.v1d.io/releases/agentmux-link/phone/app-2.apk",
        10, "a".repeat(64), "", 1, 2
    );

    @Test
    public void exactPackageVersionAndPinnedSignerAreRequired() {
        ApkIdentityVerifier.Identity installed = identity(PACKAGE, "1.0.0", 1, SIGNER);
        ApkIdentityVerifier.Identity archive = identity(PACKAGE, "1.1.0", 2, SIGNER);

        assertNull(ApkIdentityVerifier.rejection(
            installed, archive, PACKAGE, SIGNER, RELEASE
        ));
        assertEquals("signer mismatch", ApkIdentityVerifier.rejection(
            installed, identity(PACKAGE, "1.1.0", 2, "OTHER"), PACKAGE, SIGNER, RELEASE
        ));
        assertEquals("package mismatch", ApkIdentityVerifier.rejection(
            installed, identity("other.package", "1.1.0", 2, SIGNER),
            PACKAGE, SIGNER, RELEASE
        ));
        assertEquals("version metadata mismatch", ApkIdentityVerifier.rejection(
            installed, identity(PACKAGE, "1.1.1", 2, SIGNER), PACKAGE, SIGNER, RELEASE
        ));
    }

    private static ApkIdentityVerifier.Identity identity(
        String packageName,
        String versionName,
        long versionCode,
        String signer
    ) {
        return new ApkIdentityVerifier.Identity(
            packageName, versionName, versionCode, Set.of(signer)
        );
    }
}
