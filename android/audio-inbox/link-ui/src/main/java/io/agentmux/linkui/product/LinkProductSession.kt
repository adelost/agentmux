package io.agentmux.linkui.product

import com.adelost.designkit.ui.CircleSurfaceClass
import io.agentmux.linkui.product.generated.LinkArtifactProfile
import io.agentmux.linkui.product.generated.LinkComponentId
import io.agentmux.linkui.product.generated.LinkMenuAction
import io.agentmux.linkui.product.generated.LinkMenuActionDescriptor
import io.agentmux.linkui.product.generated.LinkProductManifest
import io.agentmux.linkui.product.generated.LinkRoute
import io.agentmux.linkui.product.generated.LinkRouteDescriptor

/** One compiled ProductSpec selection shared by a host's navigation and rows. */
class LinkProductSession(
    val artifactProfile: LinkArtifactProfile,
) {
    init {
        require(artifactProfile.id in LinkNativeBindings.profiles)
        requireExactNativeGraph()
    }

    val canvasColor get() = LinkNativeBindings.canvasColor

    fun route(route: LinkRoute): LinkRouteDescriptor =
        LinkProductManifest.route(route).also { require(artifactProfile in it.artifacts) }

    fun action(action: LinkMenuAction): LinkMenuActionDescriptor =
        LinkProductManifest.action(action).also { require(artifactProfile in it.artifacts) }

    fun components(route: LinkRoute, surface: String): List<LinkNativeComponentBinding> {
        require(surface in artifactProfile.surfaces) {
            "${artifactProfile.id} does not support $surface"
        }
        route(route)
        return LinkProductManifest.tree(route, surface).mounts.mapNotNull { mount ->
            val descriptor = LinkProductManifest.component(mount.component)
            if (artifactProfile !in descriptor.artifacts) {
                require(mount.optional) {
                    "Required ${mount.component.id} is unavailable in ${artifactProfile.id}"
                }
                null
            } else {
                LinkNativeBindings.requireComponent(mount.component.id).also { native ->
                    require(native.renderer.id == descriptor.rendererId)
                    require(artifactProfile.id in native.profiles)
                }
            }
        }
    }

    fun components(route: LinkRoute, surface: CircleSurfaceClass): List<LinkNativeComponentBinding> =
        components(
            route,
            when (surface) {
                CircleSurfaceClass.ROUND -> "round"
                CircleSurfaceClass.PHONE_COMPACT -> "compact"
                CircleSurfaceClass.PHONE_WIDE -> "wide"
            },
        )

    fun icon(iconId: String) = LinkNativeBindings.requireIcon(iconId)

    fun icon(component: LinkNativeComponentBinding) = icon(
        LinkProductManifest.component(
            LinkComponentId.entries.single { it.id == component.componentId },
        ).iconId,
    )

    private fun requireExactNativeGraph() {
        require(LinkProductManifest.components.map { it.id.id }.toSet() ==
            LinkNativeBindings.components.map { it.componentId }.toSet())
        require(LinkProductManifest.services.map { it.id }.toSet() ==
            LinkNativeBindings.services.map { it.serviceId }.toSet())
        LinkProductManifest.services.forEach { declared ->
            val native = LinkNativeBindings.services.single { it.serviceId == declared.id }
            require(native.port.id == declared.nativePortId)
            require(native.inputPorts == declared.inputPorts.toSet())
            require(native.outputPorts == declared.outputPorts.toSet())
            require(artifactProfile.id in native.profiles)
        }
        require(LinkProductManifest.finiteValues.map { it.id }.toSet() ==
            LinkNativeBindings.finiteValues.map { it.id }.toSet())
        LinkProductManifest.finiteValues.forEach { declared ->
            val native = LinkNativeBindings.finiteValues.single { it.id == declared.id }
            require(declared.values == native.values)
        }
        LinkComponentId.entries.forEach { LinkProductManifest.component(it) }
        requireTotalComponentWiring()
    }

    /** Every component resolves to typed ui-entry portRefs or a named framework reason. */
    private fun requireTotalComponentWiring() {
        val uiEntryIds = LinkProductManifest.uiEntries.map { it.id }.toSet()
        LinkProductManifest.uiEntries.forEach { entry ->
            listOfNotNull(entry.stateRef, entry.actionRef, entry.valueRef).forEach { ref ->
                val descriptor = LinkProductManifest.services.single { it.id == ref.substringBefore('.') }
                val portId = ref.substringAfter('.')
                require(portId in descriptor.inputPorts + descriptor.outputPorts) {
                    "ui entry ${entry.id} references unknown port $ref"
                }
            }
        }
        require(LinkProductManifest.componentWiring.map { it.component }.toSet() ==
            LinkComponentId.entries.toSet())
        LinkProductManifest.componentWiring.forEach { wiring ->
            require(wiring.uiEntries.isNotEmpty() != (wiring.frameworkReason != null)) {
                "${wiring.component.id} must bind ui entries or one framework reason"
            }
            wiring.uiEntries.forEach { entry ->
                require(entry in uiEntryIds) { "${wiring.component.id} binds unknown ui entry $entry" }
            }
        }
    }
}
