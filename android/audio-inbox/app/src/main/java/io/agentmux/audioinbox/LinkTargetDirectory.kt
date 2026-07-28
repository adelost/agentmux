package io.agentmux.audioinbox

import java.util.concurrent.ConcurrentHashMap

/**
 * Owns the discovered routes for each logical Link target.
 *
 * Private Tailnet and public routes are kept separately so rebuilding the
 * visible directory can always apply [LinkTargetRoutePolicy] consistently.
 */
internal class LinkTargetDirectory {
    private val targets = ConcurrentHashMap<String, ConversationTarget>()
    private val tailnetTargets = ConcurrentHashMap<String, ConversationTarget>()
    private val publicTargets = ConcurrentHashMap<String, ConversationTarget>()

    fun target(id: String?): ConversationTarget? = targets[id]

    fun contains(id: String): Boolean = targets.containsKey(id)

    fun isEmpty(): Boolean = targets.isEmpty()

    fun hasTailnetRoutes(): Boolean = tailnetTargets.isNotEmpty()

    fun hasAvailablePublicRoute(): Boolean =
        publicTargets.values.any(ConversationTarget::available)

    fun addTailnet(routes: Iterable<ConversationTarget>) {
        routes.forEach { tailnetTargets[it.id] = it }
    }

    fun replacePublic(routes: Iterable<ConversationTarget>) {
        publicTargets.clear()
        routes.forEach { publicTargets[it.id] = it }
    }

    fun clearPublic() {
        publicTargets.clear()
    }

    @Synchronized
    fun rebuild(): List<ConversationTarget> {
        val chosen = (tailnetTargets.keys + publicTargets.keys)
            .toSortedSet()
            .mapNotNull { id ->
                LinkTargetRoutePolicy.choose(tailnetTargets[id], publicTargets[id])
            }
            .sortedBy { favoriteOrder(it.id) }
        targets.clear()
        chosen.forEach { targets[it.id] = it }
        return chosen
    }

    private fun favoriteOrder(id: String): Int = when (id) {
        "lsrc:3" -> 0
        "lsrc:10" -> 1
        "_windows_" -> 2
        else -> 3
    }
}
