package io.agentmux.linkui.product

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The native side of navigation.service: it owns the current destination and
 * accepts route opens from the generated openSettings/openDevHost sinks. Host
 * chrome (back handling) may open HOME directly; there is no component event
 * for it by design.
 */
class LinkNavigationController(
    initial: LinkRoute,
) {
    private val mutableRoute = MutableStateFlow(initial)
    val route: StateFlow<LinkRoute> = mutableRoute.asStateFlow()

    fun open(route: LinkRoute) {
        mutableRoute.value = route
    }
}
