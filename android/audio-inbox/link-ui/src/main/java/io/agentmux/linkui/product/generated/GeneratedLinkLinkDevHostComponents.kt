// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM ProductConfig.componentFamilies
// Product declarations SHA-256: 9dc2f17efa57eab612d3c63d9f483d8763c254f242b02071052c0d3f06afd1eb
package io.agentmux.linkui.product.generated

import com.adelost.designkit.ui.CircleSurfaceClass

enum class GeneratedLinkLinkDevHostComponent(val id: GeneratedLinkComponentId) {
    DEV_PREVIEW(GeneratedLinkComponentId.DEV_PREVIEW)
}
enum class GeneratedLinkLinkDevHostRegion { CONTENT }

data class GeneratedLinkLinkDevHostMount(
    val id: String,
    val component: GeneratedLinkLinkDevHostComponent,
    val region: GeneratedLinkLinkDevHostRegion,
    val order: Int,
    val priority: Int,
    val capacity: Int?,
    val required: Boolean,
)

data class GeneratedLinkLinkDevHostTree(val mounts: List<GeneratedLinkLinkDevHostMount>) {
    val orderedMounts: List<GeneratedLinkLinkDevHostMount> = mounts.sortedWith(
        compareBy(GeneratedLinkLinkDevHostMount::order).thenBy(GeneratedLinkLinkDevHostMount::priority),
    )

    init {
        require(mounts.map { it.id }.distinct().size == mounts.size)
        require(mounts.map { it.region to it.order }.distinct().size == mounts.size)
        require(mounts == orderedMounts)
    }
}

object GeneratedLinkLinkDevHostComponents {
    val declaredSurfaceClasses: Set<CircleSurfaceClass> = setOf(
        CircleSurfaceClass.ROUND,
        CircleSurfaceClass.PHONE_COMPACT,
        CircleSurfaceClass.PHONE_WIDE,
    )

    fun resolve(surfaceClass: CircleSurfaceClass): GeneratedLinkLinkDevHostTree = when (surfaceClass) {
        CircleSurfaceClass.ROUND -> GeneratedLinkLinkDevHostTree(listOf(
            GeneratedLinkLinkDevHostMount(
                id = "dev-preview",
                component = GeneratedLinkLinkDevHostComponent.DEV_PREVIEW,
                region = GeneratedLinkLinkDevHostRegion.CONTENT,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        CircleSurfaceClass.PHONE_COMPACT -> GeneratedLinkLinkDevHostTree(listOf(
            GeneratedLinkLinkDevHostMount(
                id = "dev-preview",
                component = GeneratedLinkLinkDevHostComponent.DEV_PREVIEW,
                region = GeneratedLinkLinkDevHostRegion.CONTENT,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        CircleSurfaceClass.PHONE_WIDE -> GeneratedLinkLinkDevHostTree(listOf(
            GeneratedLinkLinkDevHostMount(
                id = "dev-preview",
                component = GeneratedLinkLinkDevHostComponent.DEV_PREVIEW,
                region = GeneratedLinkLinkDevHostRegion.CONTENT,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        else -> error("link.dev-host does not serve $surfaceClass")
    }
}
