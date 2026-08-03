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

    val canvasColor get() = requireNotNull(
        LinkNativeBindings.palettes.singleOrNull {
            it.paletteId == LinkProductManifest.palettes.single().id &&
                artifactProfile.id in it.profiles
        },
    ).canvas

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
            require(native.inputPorts == declared.inputPorts.toSet())
            require(native.outputPorts == declared.outputPorts.toSet())
            require(artifactProfile.id in native.profiles)
        }
        LinkComponentId.entries.forEach { LinkProductManifest.component(it) }
    }
}
