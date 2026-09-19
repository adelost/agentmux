// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM ProductConfig.componentFamilies
// Product declarations SHA-256: eb42010b6856eab6fcb4733d764291775102f70dec19dcba8c22d2eda2fbb786
package io.agentmux.linkui.product.generated

import com.adelost.designkit.ui.CircleSurfaceClass

enum class GeneratedLinkWakeDebugComponent(val id: GeneratedLinkComponentId) {
    NAVIGATION_PAGE_HOST(GeneratedLinkComponentId.NAVIGATION_PAGE_HOST), WAKE_DEBUG(GeneratedLinkComponentId.WAKE_DEBUG)
}
enum class GeneratedLinkWakeDebugRegion { HOST, CONTENT }

data class GeneratedLinkWakeDebugMount(
    val id: String,
    val component: GeneratedLinkWakeDebugComponent,
    val region: GeneratedLinkWakeDebugRegion,
    val order: Int,
    val priority: Int,
    val capacity: Int?,
    val required: Boolean,
)

data class GeneratedLinkWakeDebugTree(val mounts: List<GeneratedLinkWakeDebugMount>) {
    val orderedMounts: List<GeneratedLinkWakeDebugMount> = mounts.sortedWith(
        compareBy(GeneratedLinkWakeDebugMount::order).thenBy(GeneratedLinkWakeDebugMount::priority),
    )

    init {
        require(mounts.map { it.id }.distinct().size == mounts.size)
        require(mounts.map { it.region to it.order }.distinct().size == mounts.size)
        require(mounts == orderedMounts)
    }
}

object GeneratedLinkWakeDebugComponents {
    val declaredSurfaceClasses: Set<CircleSurfaceClass> = setOf(
        CircleSurfaceClass.ROUND,
        CircleSurfaceClass.PHONE_COMPACT,
        CircleSurfaceClass.PHONE_WIDE,
    )

    fun resolve(surfaceClass: CircleSurfaceClass): GeneratedLinkWakeDebugTree = when (surfaceClass) {
        CircleSurfaceClass.ROUND -> GeneratedLinkWakeDebugTree(listOf(
            GeneratedLinkWakeDebugMount(
                id = "navigation.page-host",
                component = GeneratedLinkWakeDebugComponent.NAVIGATION_PAGE_HOST,
                region = GeneratedLinkWakeDebugRegion.HOST,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkWakeDebugMount(
                id = "wake.debug",
                component = GeneratedLinkWakeDebugComponent.WAKE_DEBUG,
                region = GeneratedLinkWakeDebugRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        CircleSurfaceClass.PHONE_COMPACT -> GeneratedLinkWakeDebugTree(listOf(
            GeneratedLinkWakeDebugMount(
                id = "navigation.page-host",
                component = GeneratedLinkWakeDebugComponent.NAVIGATION_PAGE_HOST,
                region = GeneratedLinkWakeDebugRegion.HOST,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkWakeDebugMount(
                id = "wake.debug",
                component = GeneratedLinkWakeDebugComponent.WAKE_DEBUG,
                region = GeneratedLinkWakeDebugRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        CircleSurfaceClass.PHONE_WIDE -> GeneratedLinkWakeDebugTree(listOf(
            GeneratedLinkWakeDebugMount(
                id = "navigation.page-host",
                component = GeneratedLinkWakeDebugComponent.NAVIGATION_PAGE_HOST,
                region = GeneratedLinkWakeDebugRegion.HOST,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkWakeDebugMount(
                id = "wake.debug",
                component = GeneratedLinkWakeDebugComponent.WAKE_DEBUG,
                region = GeneratedLinkWakeDebugRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        else -> error("link.wake-debug does not serve $surfaceClass")
    }
}
