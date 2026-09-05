package io.agentmux.linkcore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * WHAT: Serializes reducer transitions with their ordered durable persistence.
 * WHY: Keeps concurrent discovery and reply callbacks from overwriting each other.
 */
class LinkStateLedger(
    initial: LinkState,
    private val persist: (LinkState) -> Unit,
) {
    private val mutable = MutableStateFlow(initial.copy(turns = LinkHistoryPolicy.retain(initial.turns)))
    val state = mutable.asStateFlow()
    val value: LinkState get() = mutable.value

    @Synchronized
    fun dispatch(action: LinkAction) {
        val next = LinkReducer.reduce(mutable.value, action)
        persist(next)
        mutable.value = next
    }
}
