package io.agentmux.linkui.product

import io.agentmux.linkui.product.generated.GeneratedLinkArtifactRef
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The native side of navigation.service. The selected artifact registration
 * is also what schema5 serializes, so allowed pages, entry and back behavior
 * cannot drift from the manifest while the runtime follows another table.
 */
class LinkNavigationController(
    artifact: GeneratedLinkArtifactRef,
    initial: LinkRoute? = null,
    initialPrevious: LinkRoute? = null,
) {
    private val registration = LinkNativeBindings.requireNavigationArtifact(artifact)
    private val initialPage = initial ?: registration.entryPage
    private val history = mutableListOf<LinkRoute>()
    private val mutableRoute = MutableStateFlow(registration.requirePage(initialPage).page)
    val route: StateFlow<LinkRoute> = mutableRoute.asStateFlow()

    init {
        initialPrevious?.let { history += registration.requirePage(it).page }
    }

    fun open(target: LinkRoute) {
        registration.requirePage(target)
        if (target == mutableRoute.value) return
        history += mutableRoute.value
        mutableRoute.value = target
    }

    /** Returns false only when the artifact delegates its root back to system. */
    fun back(): Boolean = when (registration.requirePage(mutableRoute.value).back) {
        LinkNativePageBack.PREVIOUS -> {
            mutableRoute.value = history.removeLastOrNull() ?: registration.entryPage
            true
        }
        LinkNativePageBack.CONSUME -> true
        LinkNativePageBack.SYSTEM -> false
    }
}
