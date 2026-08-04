package io.agentmux.audioinbox

/**
 * Owns the discovered routes for each logical Link target.
 *
 * Private Tailnet and public routes are kept separately so rebuilding the
 * visible directory can always apply [LinkTargetRoutePolicy] consistently.
 */
internal class LinkTargetDirectory {
    private val targets = linkedMapOf<String, ConversationTarget>()
    private val tailnetTargets = linkedMapOf<String, ConversationTarget>()
    private val publicTargets = linkedMapOf<String, ConversationTarget>()

    @Synchronized
    fun target(id: String?): ConversationTarget? = targets[id]

    @Synchronized
    fun kind(id: String): ConversationTarget.Kind? = targets[id]?.kind

    @Synchronized
    fun contains(id: String): Boolean = targets.containsKey(id)

    @Synchronized
    fun isEmpty(): Boolean = targets.isEmpty()

    @Synchronized
    fun hasTailnetRoutes(): Boolean = tailnetTargets.isNotEmpty()

    @Synchronized
    fun hasAvailablePublicRoute(): Boolean =
        publicTargets.values.any(ConversationTarget::available)

    @Synchronized
    fun addTailnet(routes: Iterable<ConversationTarget>) {
        routes.forEach { tailnetTargets[it.id] = it }
    }

    @Synchronized
    fun replacePublic(routes: Iterable<ConversationTarget>) {
        publicTargets.clear()
        routes.forEach { publicTargets[it.id] = it }
    }

    @Synchronized
    fun updatePublicAvailability(states: Map<String, Boolean>) {
        publicTargets.replaceAll { id, target ->
            ConversationTarget.publicLink(id, target.label, states[id] ?: false)
        }
    }

    @Synchronized
    fun clearPublic() {
        publicTargets.clear()
    }

    @Synchronized
    fun rebuild(): List<ConversationTarget> {
        val chosen = (tailnetTargets.keys + publicTargets.keys)
            .distinct()
            .mapNotNull { id ->
                LinkTargetRoutePolicy.choose(tailnetTargets[id], publicTargets[id])
            }
        targets.clear()
        chosen.forEach { targets[it.id] = it }
        return chosen
    }
}
