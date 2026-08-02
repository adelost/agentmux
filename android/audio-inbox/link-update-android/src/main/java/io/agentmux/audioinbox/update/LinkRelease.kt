package io.agentmux.audioinbox.update

import com.adelost.releasekit.HttpsPrefixAssetUrlPolicy
import com.adelost.releasekit.ReleaseCandidate as SharedReleaseCandidate
import com.adelost.releasekit.ReleaseFetchResult
import com.adelost.releasekit.ReleaseProductContract
import com.adelost.releasekit.ReleaseSource
import com.adelost.servicekit.ServiceId
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * One signed catalog consumed by CircleKit's shared update engine.
 *
 * Phone and Wear differ only in channel URL, cache identity and version
 * sequence. Keeping those differences as data means neither host can grow a
 * private downloader, verifier or installer flow.
 */
data class LinkReleaseCatalog(
    val channel: String,
    val manifestUrl: String,
    val product: ReleaseProductContract,
)

object LinkReleaseCatalogs {
    val PHONE: LinkReleaseCatalog = catalog("phone")
    val WEAR: LinkReleaseCatalog = catalog("wear")

    private fun catalog(channel: String): LinkReleaseCatalog {
        val manifestUrl =
            "https://link.v1d.io/releases/agentmux-link/$channel/manifest-v1.json"
        val manifestUri = URI(manifestUrl)
        return LinkReleaseCatalog(
            channel = channel,
            manifestUrl = manifestUrl,
            product = ReleaseProductContract(
                id = "agentmux-link-$channel",
                // Data Layer peers intentionally share package and signer;
                // they are installed on separate device families.
                packageName = "io.agentmux.audioinbox",
                userAgent = "agentmux-link-$channel-updater",
                cacheFileName = "agentmux-link-$channel-update.apk",
                telemetryServiceId = ServiceId("agentmux-link.$channel.updates"),
                assetUrlPolicy = HttpsPrefixAssetUrlPolicy(
                    host = manifestUri.host,
                    pathPrefix = manifestUri.path.substringBeforeLast('/') + "/",
                ),
                candidateIsNewer = { candidate, _, currentVersionCode ->
                    (candidate.versionCode ?: 0) > currentVersionCode
                },
            ) { _, assetName -> assetName.substringAfterLast("-v").removeSuffix(".apk") },
        )
    }
}

/**
 * Link's signed-manifest adapter onto CircleKit's shared updater.
 *
 * CircleKit owns download, APK verification, cache, installer handoff and
 * update-state projection. This class only reads Link's channel-specific
 * detached manifest and maps it to CircleKit's candidate.
 */
class SignedLinkReleaseSource(
    private val catalog: LinkReleaseCatalog,
    private val nowEpochMs: () -> Long = System::currentTimeMillis,
) : ReleaseSource {
    override fun fetchNewest(product: ReleaseProductContract): ReleaseFetchResult = try {
        check(product === catalog.product) { "release catalog/product mismatch" }
        val manifest = fetch(catalog.manifestUrl, MANIFEST_BUDGET_BYTES)
        val signature = fetch(catalog.manifestUrl + ".sig", SIGNATURE_BUDGET_BYTES)
        val verified = ReleaseManifestVerifier.verify(
            manifest,
            signature,
            nowEpochMs(),
            catalog,
        )
        ReleaseFetchResult.Success(verified.toSharedCandidate())
    } catch (error: Exception) {
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
            setRequestProperty("User-Agent", catalog.product.userAgent)
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

    private companion object {
        const val MANIFEST_BUDGET_BYTES = 64 * 1024
        const val SIGNATURE_BUDGET_BYTES = 4 * 1024
    }
}

internal fun ReleaseCandidate.toSharedCandidate(): SharedReleaseCandidate = SharedReleaseCandidate(
    versionName = versionName(),
    assetName = apkUrl().substringAfterLast('/').ifBlank { "agentmux-link.apk" },
    downloadUrl = apkUrl(),
    sizeBytes = sizeBytes(),
    sha256 = sha256(),
    versionCode = versionCode(),
    validUntilEpochMs = expiresAtMs(),
    changelog = changelog(),
    // The publisher creates this signed UTC instant immediately before its
    // immutable-first upload and makes this exact manifest public last.
    publishedAtEpochMillis = createdAtMs(),
)
