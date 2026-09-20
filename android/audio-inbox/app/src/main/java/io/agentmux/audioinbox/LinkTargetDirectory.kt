package io.agentmux.audioinbox

import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkcore.LinkTargetModel
import io.agentmux.linkcore.LinkTargetModelStatus

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
            ConversationTarget.publicLink(id, target.label, states[id] ?: false, target.model)
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
                val chosen = LinkTargetRoutePolicy.choose(tailnetTargets[id], publicTargets[id])
                    ?: return@mapNotNull null
                val freshestModel = publicTargets[id]?.model ?: tailnetTargets[id]?.model
                if (chosen.model === freshestModel) chosen else chosen.withModel(freshestModel)
            }
        targets.clear()
        chosen.forEach { targets[it.id] = it }
        return chosen
    }

    @Synchronized
    fun rebuildLinkTargets(): List<LinkTarget> = rebuild().map { target ->
        LinkTarget(
            id = target.id,
            label = target.label,
            available = target.available(),
            acceptsMessages = target.kind == ConversationTarget.Kind.PUBLIC || target.available(),
            model = target.model?.asDomainModel(),
        )
    }

    private fun ConversationTarget.Model.asDomainModel() = LinkTargetModel(
        status = when (status) {
            "current" -> LinkTargetModelStatus.CURRENT
            "stale" -> LinkTargetModelStatus.STALE
            else -> LinkTargetModelStatus.UNKNOWN
        },
        observedModel = observedModel,
        observedEffort = observedEffort,
        configuredModel = configuredModel,
        configuredEffort = configuredEffort,
    )
}
