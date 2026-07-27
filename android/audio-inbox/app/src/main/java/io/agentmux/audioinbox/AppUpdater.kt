package io.agentmux.audioinbox

import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageInstaller
import io.agentmux.linkcore.UpdatePolicy
import io.agentmux.linkcore.UpdatePresentation
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

internal class AppUpdater(
    context: Context,
    private val listener: (UpdatePresentation) -> Unit,
) : AutoCloseable {
    private val app = context.applicationContext
    private val preferences: SharedPreferences =
        app.getSharedPreferences(AppContract.PREFS, Context.MODE_PRIVATE)
    private val work: ExecutorService = Executors.newSingleThreadExecutor()
    @Volatile private var candidate: ReleaseCandidate? = null
    @Volatile private var readyFile: File? = null
    @Volatile private var running = false

    fun start() {
        if (running) return
        running = true
        work.execute {
            restoreReady()?.let {
                publish("ready-to-install", it.versionName(), "Verified and ready", 1f, true)
                running = false
                return@execute
            }
            checkAndDownload()
        }
    }

    fun retry() {
        if (running) return
        running = true
        work.execute(::checkAndDownload)
    }

    fun install() {
        val release = candidate ?: return
        val file = readyFile ?: return
        if (running) return
        running = true
        publish("installing", release.versionName(), "Verifying before installer handoff", 1f)
        work.execute {
            try {
                verifyDownloaded(file, release)
                UpdateInstaller.install(app, file)
                publish(
                    "installing",
                    release.versionName(),
                    "Android confirmation required",
                    1f,
                )
            } catch (error: Exception) {
                publishFailure(error)
            } finally {
                running = false
            }
        }
    }

    fun resumeInstallerStatus() {
        val status = preferences.getInt(
            AppContract.KEY_UPDATE_INSTALL_STATUS,
            PackageInstaller.STATUS_SUCCESS,
        )
        if (status <= PackageInstaller.STATUS_FAILURE && candidate != null && readyFile != null) {
            preferences.edit().remove(AppContract.KEY_UPDATE_INSTALL_STATUS).apply()
            publish(
                "ready-to-install",
                candidate?.versionName().orEmpty(),
                "Install was not completed · tap Install to retry",
                1f,
                canInstall = true,
            )
        }
    }

    private fun checkAndDownload() {
        try {
            publish("checking", "", "Checking signed release catalog")
            val manifest = fetch(ReleaseManifestVerifier.MANIFEST_URL, 64 * 1024)
            val signature = fetch(ReleaseManifestVerifier.MANIFEST_URL + ".sig", 4 * 1024)
            val release = ReleaseManifestVerifier.verify(
                manifest,
                signature,
                System.currentTimeMillis(),
            )
            if (!UpdatePolicy.isStrictUpgrade(
                    BuildConfig.VERSION_CODE,
                    BuildConfig.VERSION_NAME,
                    release.versionCode(),
                    release.versionName(),
                )
            ) {
                publish("up-to-date", "", "Current version is up to date")
                return
            }
            candidate = release
            publish("available", release.versionName(), "Update available · downloading")
            val file = SecureUpdateDownloader.download(app, release) { progress ->
                publish(
                    "downloading",
                    release.versionName(),
                    "${(progress * 100).toInt()}% downloaded",
                    progress,
                )
            }
            verifyDownloaded(file, release)
            readyFile = file
            persistReady(release, file)
            publish(
                "ready-to-install",
                release.versionName(),
                "Verified · tap Install",
                1f,
                canInstall = true,
            )
        } catch (error: Exception) {
            publishFailure(error)
        } finally {
            running = false
        }
    }

    private fun restoreReady(): ReleaseCandidate? {
        val encoded = preferences.getString(AppContract.KEY_UPDATE_READY, null) ?: return null
        return runCatching {
            val json = JSONObject(encoded)
            val release = ReleaseCandidate(
                json.getInt("versionCode"),
                json.getString("versionName"),
                json.getString("apkUrl"),
                json.getLong("sizeBytes"),
                json.getString("sha256"),
                json.optString("changelog"),
                json.getLong("createdAtMs"),
                json.getLong("expiresAtMs"),
            )
            val file = File(json.getString("path"))
            require(release.expiresAtMs() > System.currentTimeMillis())
            require(
                UpdatePolicy.isStrictUpgrade(
                    BuildConfig.VERSION_CODE,
                    BuildConfig.VERSION_NAME,
                    release.versionCode(),
                    release.versionName(),
                ),
            )
            verifyDownloaded(file, release)
            candidate = release
            readyFile = file
            release
        }.getOrElse {
            preferences.edit().remove(AppContract.KEY_UPDATE_READY).apply()
            null
        }
    }

    private fun verifyDownloaded(file: File, release: ReleaseCandidate) {
        if (!SecureUpdateDownloader.verifyFile(file, release)) {
            throw SecurityException("downloaded update hash mismatch")
        }
        ApkIdentityVerifier.rejection(app, file, release)?.let {
            throw SecurityException(it)
        }
    }

    private fun persistReady(release: ReleaseCandidate, file: File) {
        val json = JSONObject()
            .put("versionCode", release.versionCode())
            .put("versionName", release.versionName())
            .put("apkUrl", release.apkUrl())
            .put("sizeBytes", release.sizeBytes())
            .put("sha256", release.sha256())
            .put("changelog", release.changelog())
            .put("createdAtMs", release.createdAtMs())
            .put("expiresAtMs", release.expiresAtMs())
            .put("path", file.absolutePath)
        preferences.edit().putString(AppContract.KEY_UPDATE_READY, json.toString()).apply()
    }

    private fun fetch(rawUrl: String, maxBytes: Int): String {
        val connection = URL(rawUrl).openConnection() as HttpURLConnection
        connection.requestMethod = "GET"
        connection.connectTimeout = 10_000
        connection.readTimeout = 20_000
        connection.instanceFollowRedirects = false
        connection.setRequestProperty("Accept", "application/json, text/plain")
        return try {
            if (connection.responseCode != 200) {
                error("release catalog HTTP ${connection.responseCode}")
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

    private fun publishFailure(error: Exception) {
        val detail = error.message.orEmpty().replace(Regex("[\\r\\n]+"), " ").take(160)
        publish("failed", candidate?.versionName().orEmpty(), detail, canRetry = true)
    }

    private fun publish(
        state: String,
        available: String,
        detail: String,
        progress: Float = 0f,
        canInstall: Boolean = false,
        canRetry: Boolean = false,
    ) {
        listener(
            UpdatePresentation(
                currentVersion = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
                availableVersion = available,
                state = state,
                detail = detail,
                changelog = candidate?.changelog().orEmpty(),
                progress = progress,
                canInstall = canInstall,
                canRetry = canRetry,
            ),
        )
    }

    override fun close() {
        work.shutdownNow()
    }
}
