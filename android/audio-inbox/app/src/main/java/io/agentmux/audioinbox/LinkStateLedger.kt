package io.agentmux.audioinbox

import io.agentmux.linkcore.LinkAction
import io.agentmux.linkcore.LinkReducer
import io.agentmux.linkcore.LinkState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * WHAT: Serializes reducer transitions with their ordered durable persistence.
 * WHY: Keeps concurrent discovery and reply callbacks from overwriting each other.
 */
internal class LinkStateLedger(
    initial: LinkState,
    private val persist: (LinkState) -> Unit,
) {
    private val mutable = MutableStateFlow(initial)
    val state = mutable.asStateFlow()
    val value: LinkState get() = mutable.value

    @Synchronized
    fun dispatch(action: LinkAction) {
        val next = LinkReducer.reduce(mutable.value, action)
        persist(next)
        mutable.value = next
    }
}
