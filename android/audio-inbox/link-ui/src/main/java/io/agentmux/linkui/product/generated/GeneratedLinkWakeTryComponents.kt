// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM ProductConfig.componentFamilies
// Product declarations SHA-256: bc60e3a6743789c16dd3cd8c875d608813657a5e5f8338d29199e10921ec36bb
package io.agentmux.linkui.product.generated

import com.adelost.designkit.ui.CircleSurfaceClass

enum class GeneratedLinkWakeTryComponent(val id: GeneratedLinkComponentId) {
    NAVIGATION_PAGE_HOST(GeneratedLinkComponentId.NAVIGATION_PAGE_HOST), WAKE_TRY(GeneratedLinkComponentId.WAKE_TRY)
}
enum class GeneratedLinkWakeTryRegion { HOST, CONTENT }

data class GeneratedLinkWakeTryMount(
    val id: String,
    val component: GeneratedLinkWakeTryComponent,
    val region: GeneratedLinkWakeTryRegion,
    val order: Int,
    val priority: Int,
    val capacity: Int?,
    val required: Boolean,
)

data class GeneratedLinkWakeTryTree(val mounts: List<GeneratedLinkWakeTryMount>) {
    val orderedMounts: List<GeneratedLinkWakeTryMount> = mounts.sortedWith(
        compareBy(GeneratedLinkWakeTryMount::order).thenBy(GeneratedLinkWakeTryMount::priority),
    )

    init {
        require(mounts.map { it.id }.distinct().size == mounts.size)
        require(mounts.map { it.region to it.order }.distinct().size == mounts.size)
        require(mounts == orderedMounts)
    }
}

object GeneratedLinkWakeTryComponents {
    val declaredSurfaceClasses: Set<CircleSurfaceClass> = setOf(
        CircleSurfaceClass.ROUND,
        CircleSurfaceClass.PHONE_COMPACT,
        CircleSurfaceClass.PHONE_WIDE,
    )

    fun resolve(surfaceClass: CircleSurfaceClass): GeneratedLinkWakeTryTree = when (surfaceClass) {
        CircleSurfaceClass.ROUND -> GeneratedLinkWakeTryTree(listOf(
            GeneratedLinkWakeTryMount(
                id = "navigation.page-host",
                component = GeneratedLinkWakeTryComponent.NAVIGATION_PAGE_HOST,
                region = GeneratedLinkWakeTryRegion.HOST,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkWakeTryMount(
                id = "wake.try",
                component = GeneratedLinkWakeTryComponent.WAKE_TRY,
                region = GeneratedLinkWakeTryRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        CircleSurfaceClass.PHONE_COMPACT -> GeneratedLinkWakeTryTree(listOf(
            GeneratedLinkWakeTryMount(
                id = "navigation.page-host",
                component = GeneratedLinkWakeTryComponent.NAVIGATION_PAGE_HOST,
                region = GeneratedLinkWakeTryRegion.HOST,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkWakeTryMount(
                id = "wake.try",
                component = GeneratedLinkWakeTryComponent.WAKE_TRY,
                region = GeneratedLinkWakeTryRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        CircleSurfaceClass.PHONE_WIDE -> GeneratedLinkWakeTryTree(listOf(
            GeneratedLinkWakeTryMount(
                id = "navigation.page-host",
                component = GeneratedLinkWakeTryComponent.NAVIGATION_PAGE_HOST,
                region = GeneratedLinkWakeTryRegion.HOST,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkWakeTryMount(
                id = "wake.try",
                component = GeneratedLinkWakeTryComponent.WAKE_TRY,
                region = GeneratedLinkWakeTryRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        else -> error("link.wake-try does not serve $surfaceClass")
    }
}
