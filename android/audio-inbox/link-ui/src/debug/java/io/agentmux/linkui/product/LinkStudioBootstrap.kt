package io.agentmux.linkui.product

import android.app.Activity
import com.adelost.studiodebug.StudioDebugBridge
import com.adelost.studiodebug.StudioDebugIdentity
import io.agentmux.linkui.product.generated.GeneratedLinkStudioIdentity

/** A Link graph contributes its generated ports; CircleKit owns the socket, ticket, queue and command door. */
object LinkStudioBootstrap {
    private var bridge: StudioDebugBridge? = null
    @Volatile private var graph: LinkProductGraph? = null

    fun attach(activity: Activity, productGraph: LinkProductGraph) {
        graph = productGraph
        val current = bridge ?: StudioDebugBridge(
            action = "${activity.packageName}.STUDIO_OBSERVE",
            identity = StudioDebugIdentity(
                productId = GeneratedLinkStudioIdentity.productId,
                artifactSha256 = GeneratedLinkStudioIdentity.artifactSha256,
                productSpecVersion = GeneratedLinkStudioIdentity.productSpecVersion,
                buildId = requireNotNull(activity.packageManager.getPackageInfo(activity.packageName, 0).versionName) {
                    "Link debug package has no version name"
                },
                events = GeneratedLinkStudioIdentity.events,
            ),
            attachObservers = { emit, _ ->
                requireNotNull(graph) { "Link graph is not mounted for Studio observation" }
                    .attachReturnedPortObserver(emit)
            },
        ).also { bridge = it }
        current.attach(activity)
    }

    fun detach(activity: Activity) {
        bridge?.stop()
        bridge?.detach(activity)
        graph = null
    }
}
