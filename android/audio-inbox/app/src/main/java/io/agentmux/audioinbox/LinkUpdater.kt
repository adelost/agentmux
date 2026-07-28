package io.agentmux.audioinbox

import android.content.Context
import com.adelost.releasekit.UpdateController
import com.adelost.releasekit.UpdateProgress
import com.adelost.releasekit.UpdateRowAction
import com.adelost.releasekit.UpdateState
import com.adelost.releasekit.updateRowModel
import io.agentmux.linkcore.UpdatePresentation
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * Link's update surface, on the shared engine.
 *
 * Everything that used to live here — the download loop, the hash check, the
 * APK identity check, the installer handoff and its receiver, the ready-update
 * persistence — is [UpdateController] now, the same code Skyvw runs. What is
 * still Link's is where releases are announced ([LinkReleaseSource]) and who
 * it is ([LinkReleaseProducts]).
 *
 * The wording comes from CircleKit's shared projection rather than a second
 * private list of sentences, so a state added to [UpdateState] is described
 * once for both products instead of in whichever app noticed.
 */
internal class LinkUpdater(
    context: Context,
    scope: CoroutineScope,
    private val listener: (UpdatePresentation) -> Unit,
) {
    private val controller = UpdateController(
        context = context,
        scope = scope,
        product = LinkReleaseProducts.PHONE,
        currentVersionName = BuildConfig.VERSION_NAME,
        currentVersionCode = BuildConfig.VERSION_CODE,
        releaseSource = LinkReleaseSource,
    )

    init {
        scope.launch {
            controller.state.collectLatest { listener(it.toPresentation()) }
        }
    }

    fun start() = controller.checkNow()

    fun retry() = controller.checkNow()

    fun install() = controller.downloadAndInstall()

    /**
     * The controller observes real installer results, so a failed or dismissed
     * confirmation already lands in [UpdateState.InstallFailed]. Resuming only
     * has to re-check what is on disk.
     */
    fun resumeInstallerStatus() = controller.checkNow()

    private fun UpdateState.toPresentation(): UpdatePresentation {
        val row = updateRowModel(this, controller.currentVersionName)
        return UpdatePresentation(
            currentVersion = "${controller.currentVersionName} (${controller.currentVersionCode})",
            availableVersion = availableVersionName(),
            state = wireState(),
            detail = row.sub,
            changelog = changelog(),
            progress = when (val progress = row.progress) {
                is UpdateProgress.Determinate -> progress.fraction
                UpdateProgress.Indeterminate -> 0f
                null -> if (this is UpdateState.ReadyToInstall) 1f else 0f
            },
            canInstall = row.action == UpdateRowAction.INSTALL,
            canRetry = row.action == UpdateRowAction.CHECK,
        )
    }

    private fun UpdateState.availableVersionName(): String = when (this) {
        is UpdateState.Available -> versionName
        is UpdateState.Downloading -> versionName
        is UpdateState.ReadyToInstall -> versionName
        is UpdateState.Installing -> versionName
        is UpdateState.InstallFailed -> versionName
        else -> ""
    }

    /** The vocabulary LinkPhoneScreen and the Wear surface already switch on. */
    private fun UpdateState.wireState(): String = when (this) {
        UpdateState.Checking -> "checking"
        is UpdateState.Available -> "available"
        is UpdateState.Downloading -> "downloading"
        is UpdateState.ReadyToInstall -> "ready-to-install"
        is UpdateState.Installing -> "installing"
        is UpdateState.InstallFailed -> "failed"
        is UpdateState.Failed -> "failed"
        UpdateState.UpToDate -> "up-to-date"
        else -> "idle"
    }

    private fun UpdateState.changelog(): String = ""
}
