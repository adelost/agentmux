// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM ProductConfig.componentFamilies
// Product declarations SHA-256: 9dc2f17efa57eab612d3c63d9f483d8763c254f242b02071052c0d3f06afd1eb
package io.agentmux.linkui.product.generated

import com.adelost.designkit.ui.CircleSurfaceClass

enum class GeneratedLinkDevHostComponent(val id: GeneratedLinkComponentId) {
    DEV_PREVIEW(GeneratedLinkComponentId.DEV_PREVIEW)
}
enum class GeneratedLinkDevHostRegion { CONTENT }

data class GeneratedLinkDevHostMount(
    val id: String,
    val component: GeneratedLinkDevHostComponent,
    val region: GeneratedLinkDevHostRegion,
    val order: Int,
    val priority: Int,
    val capacity: Int?,
    val required: Boolean,
)

data class GeneratedLinkDevHostTree(val mounts: List<GeneratedLinkDevHostMount>) {
    val orderedMounts: List<GeneratedLinkDevHostMount> = mounts.sortedWith(
        compareBy(GeneratedLinkDevHostMount::order).thenBy(GeneratedLinkDevHostMount::priority),
    )

    init {
        require(mounts.map { it.id }.distinct().size == mounts.size)
        require(mounts.map { it.region to it.order }.distinct().size == mounts.size)
        require(mounts == orderedMounts)
    }
}

object GeneratedLinkDevHostComponents {
    val declaredSurfaceClasses: Set<CircleSurfaceClass> = setOf(
        CircleSurfaceClass.ROUND,
        CircleSurfaceClass.PHONE_COMPACT,
        CircleSurfaceClass.PHONE_WIDE,
    )

    fun resolve(surfaceClass: CircleSurfaceClass): GeneratedLinkDevHostTree = when (surfaceClass) {
        CircleSurfaceClass.ROUND -> GeneratedLinkDevHostTree(listOf(
            GeneratedLinkDevHostMount(
                id = "dev-preview",
                component = GeneratedLinkDevHostComponent.DEV_PREVIEW,
                region = GeneratedLinkDevHostRegion.CONTENT,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        CircleSurfaceClass.PHONE_COMPACT -> GeneratedLinkDevHostTree(listOf(
            GeneratedLinkDevHostMount(
                id = "dev-preview",
                component = GeneratedLinkDevHostComponent.DEV_PREVIEW,
                region = GeneratedLinkDevHostRegion.CONTENT,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        CircleSurfaceClass.PHONE_WIDE -> GeneratedLinkDevHostTree(listOf(
            GeneratedLinkDevHostMount(
                id = "dev-preview",
                component = GeneratedLinkDevHostComponent.DEV_PREVIEW,
                region = GeneratedLinkDevHostRegion.CONTENT,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        else -> error("link.dev-host does not serve $surfaceClass")
    }
}
