package io.agentmux.audioinbox

import com.adelost.releasekit.HttpsPrefixAssetUrlPolicy
import com.adelost.releasekit.ReleaseCandidate as SharedReleaseCandidate
import com.adelost.releasekit.ReleaseFetchResult
import com.adelost.releasekit.ReleaseProductContract
import com.adelost.releasekit.ReleaseSource
import com.adelost.servicekit.ServiceId
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * Link's half of the shared update engine.
 *
 * CircleKit knows how to download, hash, verify an APK's real identity, cache
 * it and hand it to the package installer. It does not know where releases are
 * announced — that is the one thing that differs between products, so it is
 * the one thing declared here.
 *
 * Link's announcement is a detached Ed25519 manifest rather than Skyvw's
 * GitHub digest feed. [ReleaseManifestVerifier] still does that verification,
 * unchanged and fail-closed; this only maps its result onto the shared
 * candidate so the rest of the flow is the same code both products run.
 */
object LinkReleaseSource : ReleaseSource {
    private const val MANIFEST_BUDGET_BYTES = 64 * 1024
    private const val SIGNATURE_BUDGET_BYTES = 4 * 1024

    override fun fetchNewest(product: ReleaseProductContract): ReleaseFetchResult = try {
        val manifest = fetch(ReleaseManifestVerifier.MANIFEST_URL, MANIFEST_BUDGET_BYTES)
        val signature = fetch(
            ReleaseManifestVerifier.MANIFEST_URL + ".sig",
            SIGNATURE_BUDGET_BYTES,
        )
        // Expiry is checked here at the moment metadata is accepted, and again
        // by UpdateController when a cached APK is restored and immediately
        // before installer handoff. A manifest that expires while its APK sits
        // in the cache never installs.
        val verified = ReleaseManifestVerifier.verify(
            manifest,
            signature,
            System.currentTimeMillis(),
        )
        ReleaseFetchResult.Success(verified.toSharedCandidate())
    } catch (error: Exception) {
        // Fail closed and say why: a source that returns "nothing new" on a
        // verification failure would look identical to being up to date.
        ReleaseFetchResult.Failure(
            error.message.orEmpty().replace(Regex("[\\r\\n]+"), " ").take(160)
                .ifBlank { "signed release manifest rejected" },
        )
    }

    private fun fetch(rawUrl: String, maxBytes: Int): String {
        val connection = (URL(rawUrl).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 10_000
            readTimeout = 20_000
            instanceFollowRedirects = false
            setRequestProperty("Accept", "application/json, text/plain")
            setRequestProperty("User-Agent", LinkReleaseProducts.PHONE.userAgent)
        }
        return try {
            check(connection.responseCode == 200) {
                "release catalog HTTP ${connection.responseCode}"
            }
            val output = ByteArrayOutputStream()
            connection.inputStream.use { input ->
                val buffer = ByteArray(4096)
                var total = 0
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    total += count
                    if (total > maxBytes) throw SecurityException("release response is oversized")
                    output.write(buffer, 0, count)
                }
            }
            output.toString(StandardCharsets.UTF_8.name())
        } finally {
            connection.disconnect()
        }
    }
}

/**
 * The verified manifest, in the vocabulary the shared engine speaks.
 *
 * `assetName` is the last path segment because the manifest names a URL, not
 * a file. It is presentation only — what actually gets verified is the digest
 * and, after download, the APK's own package, version and signer.
 */
internal fun ReleaseCandidate.toSharedCandidate(): SharedReleaseCandidate = SharedReleaseCandidate(
    versionName = versionName(),
    assetName = apkUrl().substringAfterLast('/').ifBlank { "agentmux-link.apk" },
    downloadUrl = apkUrl(),
    sizeBytes = sizeBytes(),
    sha256 = sha256(),
    versionCode = versionCode(),
    validUntilEpochMs = expiresAtMs(),
    changelog = changelog(),
)

/** Link's release identity. */
object LinkReleaseProducts {
    val PHONE = ReleaseProductContract(
        id = "agentmux-link-phone",
        packageName = "io.agentmux.audioinbox",
        userAgent = "agentmux-link-updater",
        cacheFileName = "agentmux-link-phone-update.apk",
        telemetryServiceId = ServiceId("agentmux-link.updates"),
        // The manifest names a per-version asset URL, so an exact pin cannot
        // work the way Skyvw's does. Host plus path prefix fences every hop
        // instead — including redirects, which UpdateController re-approves
        // against this same policy rather than following them blindly.
        assetUrlPolicy = HttpsPrefixAssetUrlPolicy(
            host = "link.v1d.io",
            pathPrefix = "/releases/agentmux-link/",
        ),
        // The manifest is authoritative about ordering: versionCode is a
        // monotonic integer, where a version name is only a label.
        candidateIsNewer = { candidate, _, currentVersionCode ->
            (candidate.versionCode ?: 0) > currentVersionCode
        },
    ) { _, assetName -> assetName.substringAfterLast("-v").removeSuffix(".apk") }
}
