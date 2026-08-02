package io.agentmux.audioinbox.update

import android.content.Context
import com.adelost.releasekit.UpdateController
import com.adelost.releasekit.UpdateState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.StateFlow

/**
 * Link's product adapter onto CircleKit's shared update engine.
 *
 * CircleKit owns download, verification, recovery, installation and the
 * canonical UI projection. Link supplies only its signed release source and
 * channel contract; every host observes the native [UpdateState] unchanged.
 */
class LinkUpdater(
    context: Context,
    scope: CoroutineScope,
    catalog: LinkReleaseCatalog,
    val currentVersionName: String,
    currentVersionCode: Int,
) {
    private val controller = UpdateController(
        context = context,
        scope = scope,
        product = catalog.product,
        currentVersionName = currentVersionName,
        currentVersionCode = currentVersionCode,
        releaseSource = SignedLinkReleaseSource(catalog),
    )

    /** The one update truth observed by Phone, Wear and Phone WatchExact. */
    val state: StateFlow<UpdateState> = controller.state

    fun start() = controller.checkNow()

    fun retry() = controller.checkNow()

    fun install() = controller.downloadAndInstall()

    /**
     * Installer results are observed by [UpdateController]. Resuming only
     * re-checks the signed source and any verified artifact already on disk.
     */
    fun resumeInstallerStatus() = controller.checkNow()
}
