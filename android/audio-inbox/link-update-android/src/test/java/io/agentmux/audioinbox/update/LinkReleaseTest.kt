package io.agentmux.audioinbox.update

import com.adelost.releasekit.isExpiredAt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The seam between Link's signed manifest and CircleKit's shared engine.
 *
 * ReleaseManifestVerifierTest still owns the Ed25519 verification itself.
 * What is new — and therefore what is pinned here — is the mapping onto the
 * shared candidate and the URL fence that replaced Skyvw's exact pin.
 */
class LinkReleaseTest {
    private val phone = LinkReleaseCatalogs.PHONE
    private val product = phone.product

    private fun manifestRelease(
        versionCode: Int = 42,
        expiresAtMs: Long = 2_000_000L,
        apkUrl: String = "https://link.v1d.io/releases/agentmux-link/phone/agentmux-link-v1.4.0.apk",
    ) = ReleaseCandidate(
        versionCode,
        "1.4.0",
        apkUrl,
        4_096L,
        "a".repeat(64),
        "fixed the thing",
        1_000_000L,
        expiresAtMs,
    )

    @Test
    fun `the verified manifest keeps every field the shared engine verifies against`() {
        val shared = manifestRelease().toSharedCandidate()

        assertEquals("1.4.0", shared.versionName)
        assertEquals(42, shared.versionCode)
        assertEquals(4_096L, shared.sizeBytes)
        assertEquals("a".repeat(64), shared.sha256)
        assertEquals("fixed the thing", shared.changelog)
        assertEquals(1_000_000L, shared.publishedAtEpochMillis)
        // expiresAt has to survive the mapping: it is what UpdateController
        // re-checks before installer handoff, long after this call.
        assertEquals(2_000_000L, shared.validUntilEpochMs)
        assertEquals("agentmux-link-v1.4.0.apk", shared.assetName)
    }

    @Test
    fun `an expired manifest is expired once it reaches the shared engine`() {
        val shared = manifestRelease(expiresAtMs = 1_500_000L).toSharedCandidate()
        assertTrue(shared.isExpiredAt(1_500_000L))
        assertTrue(shared.isExpiredAt(1_500_001L))
        assertFalse(shared.isExpiredAt(1_499_999L))
    }

    @Test
    fun `a manifest naming a URL with no filename still gets an asset name`() {
        val shared = manifestRelease(
            apkUrl = "https://link.v1d.io/releases/agentmux-link/phone/",
        ).toSharedCandidate()
        assertEquals("agentmux-link.apk", shared.assetName)
    }

    @Test
    fun `the fence admits Link's release path and refuses everything around it`() {
        val policy = product.assetUrlPolicy
        assertEquals(
            phone.manifestUrl.substringBeforeLast('/') + "/",
            "https://link.v1d.io/releases/agentmux-link/phone/",
        )
        assertTrue(
            policy.allows("https://link.v1d.io/releases/agentmux-link/phone/agentmux-link-v1.4.0.apk"),
        )
        assertFalse(policy.allows("https://link.v1d.io/releases/agentmux-link/wear/app.apk"))
        // A different product's releases on the same host.
        assertFalse(policy.allows("https://link.v1d.io/releases/other-app/phone/app.apk"))
        // A host that merely starts the same way.
        assertFalse(
            policy.allows("https://link.v1d.io.evil.example/releases/agentmux-link/phone/app.apk"),
        )
        // Plain HTTP, however right the rest of the URL looks.
        assertFalse(
            policy.allows("http://link.v1d.io/releases/agentmux-link/phone/agentmux-link-v1.4.0.apk"),
        )
    }

    @Test
    fun `phone and wear are isolated channels on the same signed package`() {
        val wear = LinkReleaseCatalogs.WEAR

        assertEquals("io.agentmux.audioinbox", product.packageName)
        assertEquals(product.packageName, wear.product.packageName)
        assertTrue(
            wear.product.assetUrlPolicy.allows(
                "https://link.v1d.io/releases/agentmux-link/wear/app-1.apk",
            ),
        )
        assertFalse(
            wear.product.assetUrlPolicy.allows(
                "https://link.v1d.io/releases/agentmux-link/phone/app-4.apk",
            ),
        )
        assertFalse(
            product.assetUrlPolicy.allows(
                "https://link.v1d.io/releases/agentmux-link/wear/app-1.apk",
            ),
        )
    }

    @Test
    fun `versionCode decides what is newer, because a version name is only a label`() {
        val installedCode = 42
        // A higher name with a lower code is not an upgrade: the manifest's
        // monotonic integer is what the signer actually commits to.
        assertFalse(
            product.isNewer(
                manifestRelease(versionCode = 41).toSharedCandidate(),
                "9.9.9",
                installedCode,
            ),
        )
        assertTrue(
            product.isNewer(
                manifestRelease(versionCode = 43).toSharedCandidate(),
                "0.0.1",
                installedCode,
            ),
        )
        // Equal codes are not newer — a re-published manifest must not loop.
        assertFalse(
            product.isNewer(
                manifestRelease(versionCode = 42).toSharedCandidate(),
                "1.4.0",
                installedCode,
            ),
        )
    }
}
