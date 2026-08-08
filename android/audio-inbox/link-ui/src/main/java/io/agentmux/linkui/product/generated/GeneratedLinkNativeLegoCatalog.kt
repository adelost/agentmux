// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM the portable native-Lego catalog
// Product declarations SHA-256: afea64d9da9ae8586a41926457d2a07ab33b0b7190275316989720bd6f39cb9a
package io.agentmux.linkui.product.generated

internal object GeneratedLinkNativeLegoCatalog {
    object PortIds {
        data object NAVIGATION_SERVICE_OPENSETTINGS : GeneratedProductInputPortId { override val value = "navigation.service.openSettings" }
        data object NAVIGATION_SERVICE_OPENDEVHOST : GeneratedProductInputPortId { override val value = "navigation.service.openDevHost" }
        data object NAVIGATION_SERVICE_DESTINATION : GeneratedProductOutputPortId { override val value = "navigation.service.destination" }
        data object CAPTURE_SERVICE_COMMAND : GeneratedProductInputPortId { override val value = "capture.service.command" }
        data object CAPTURE_SERVICE_STATUS : GeneratedProductOutputPortId { override val value = "capture.service.status" }
        data object CAPTURE_SERVICE_CAPTURED : GeneratedProductOutputPortId { override val value = "capture.service.captured" }
        data object CONVERSATION_SERVICE_TURN : GeneratedProductInputPortId { override val value = "conversation.service.turn" }
        data object CONVERSATION_SERVICE_COMPOSE : GeneratedProductInputPortId { override val value = "conversation.service.compose" }
        data object CONVERSATION_SERVICE_STATUS : GeneratedProductOutputPortId { override val value = "conversation.service.status" }
        data object PLAYBACK_SERVICE_COMMAND : GeneratedProductInputPortId { override val value = "playback.service.command" }
        data object PLAYBACK_SERVICE_STATUS : GeneratedProductOutputPortId { override val value = "playback.service.status" }
        data object TARGET_SERVICE_SELECT : GeneratedProductInputPortId { override val value = "target.service.select" }
        data object TARGET_SERVICE_DIRECTORY : GeneratedProductOutputPortId { override val value = "target.service.directory" }
        data object SESSION_SERVICE_STATUS : GeneratedProductOutputPortId { override val value = "session.service.status" }
        data object HISTORY_SERVICE_STATUS : GeneratedProductOutputPortId { override val value = "history.service.status" }
        data object PREFERENCES_SERVICE_TOGGLE : GeneratedProductInputPortId { override val value = "preferences.service.toggle" }
        data object PREFERENCES_SERVICE_STATUS : GeneratedProductOutputPortId { override val value = "preferences.service.status" }
        data object UPDATES_SERVICE_COMMAND : GeneratedProductInputPortId { override val value = "updates.service.command" }
        data object UPDATES_SERVICE_STATUS : GeneratedProductOutputPortId { override val value = "updates.service.status" }
        data object RECOVERY_SERVICE_STATUS : GeneratedProductOutputPortId { override val value = "recovery.service.status" }
        data object TARGET_MODEL : GeneratedProductInputPortId { override val value = "target.model" }
        data object TARGET_SELECT : GeneratedProductOutputPortId { override val value = "target.select" }
        data object TALK_MODEL : GeneratedProductInputPortId { override val value = "talk.model" }
        data object TALK_COMMAND : GeneratedProductOutputPortId { override val value = "talk.command" }
        data object LATEST_MODEL : GeneratedProductInputPortId { override val value = "latest.model" }
        data object COMPOSER_MODEL : GeneratedProductInputPortId { override val value = "composer.model" }
        data object COMPOSER_COMPOSE : GeneratedProductOutputPortId { override val value = "composer.compose" }
        data object ACTIVE_PLAYBACK_MODEL : GeneratedProductInputPortId { override val value = "active-playback.model" }
        data object ACTIVE_PLAYBACK_COMMAND : GeneratedProductOutputPortId { override val value = "active-playback.command" }
        data object CONNECTION_MODEL : GeneratedProductInputPortId { override val value = "connection.model" }
        data object PUBLIC_LINK_MODEL : GeneratedProductInputPortId { override val value = "public-link.model" }
        data object PREFERENCES_MODEL : GeneratedProductInputPortId { override val value = "preferences.model" }
        data object PREFERENCES_TOGGLE : GeneratedProductOutputPortId { override val value = "preferences.toggle" }
        data object LOCAL_HISTORY_MODEL : GeneratedProductInputPortId { override val value = "local-history.model" }
        data object UPDATES_MODEL : GeneratedProductInputPortId { override val value = "updates.model" }
        data object UPDATES_COMMAND : GeneratedProductOutputPortId { override val value = "updates.command" }
        data object RECOVERY_MODEL : GeneratedProductInputPortId { override val value = "recovery.model" }
        data object SETTINGS_ACTION_DESTINATION : GeneratedProductInputPortId { override val value = "settings-action.destination" }
        data object SETTINGS_ACTION_OPEN : GeneratedProductOutputPortId { override val value = "settings-action.open" }
        data object DEV_HOST_DESTINATION : GeneratedProductInputPortId { override val value = "dev-host.destination" }
        data object DEV_HOST_OPEN : GeneratedProductOutputPortId { override val value = "dev-host.open" }
    }
    object FiniteValueIds {
        data object LINK_ROUTE : GeneratedLinkFiniteValueId { override val value = "link.route" }
        data object LINK_CAPTURE_OPERATION : GeneratedLinkFiniteValueId { override val value = "link.capture-operation" }
        data object LINK_CAPTURE_PHASE : GeneratedLinkFiniteValueId { override val value = "link.capture-phase" }
        data object LINK_DELIVERY_PHASE : GeneratedLinkFiniteValueId { override val value = "link.delivery-phase" }
        data object LINK_REPLY_PHASE : GeneratedLinkFiniteValueId { override val value = "link.reply-phase" }
        data object LINK_PLAYBACK_OPERATION : GeneratedLinkFiniteValueId { override val value = "link.playback-operation" }
        data object LINK_PLAYBACK_PHASE : GeneratedLinkFiniteValueId { override val value = "link.playback-phase" }
        data object LINK_TARGET_KIND : GeneratedLinkFiniteValueId { override val value = "link.target-kind" }
        data object LINK_CONNECTION_STATE : GeneratedLinkFiniteValueId { override val value = "link.connection-state" }
        data object LINK_PREFERENCE_KEY : GeneratedLinkFiniteValueId { override val value = "link.preference-key" }
        data object LINK_UPDATE_OPERATION : GeneratedLinkFiniteValueId { override val value = "link.update-operation" }
        data object LINK_UPDATE_PHASE : GeneratedLinkFiniteValueId { override val value = "link.update-phase" }
        data object LINK_RECOVERY_PHASE : GeneratedLinkFiniteValueId { override val value = "link.recovery-phase" }
    }
    val finiteValues: List<GeneratedLinkFiniteValueDeclaration> = listOf(
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_ROUTE, setOf("home", "settings", "dev-host")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_CAPTURE_OPERATION, setOf("begin", "release", "cancel")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_CAPTURE_PHASE, setOf("idle", "listening", "finalizing", "failed")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_DELIVERY_PHASE, setOf("sending", "queued", "failed")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_REPLY_PHASE, setOf("none", "thinking", "ready", "failed")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_PLAYBACK_OPERATION, setOf("play", "pause", "resume", "stop")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_PLAYBACK_PHASE, setOf("idle", "queued", "playing", "paused", "stopped", "played", "skipped", "failed")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_TARGET_KIND, setOf("agent", "windows", "public")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_CONNECTION_STATE, setOf("off", "connecting", "connected", "disconnected", "configuration-required")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_PREFERENCE_KEY, setOf("hands-free", "speak-replies")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_UPDATE_OPERATION, setOf("check", "retry", "install")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_UPDATE_PHASE, setOf("idle", "checking", "up-to-date", "unavailable", "available", "downloading", "ready-to-install", "installing", "install-failed", "failed")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_RECOVERY_PHASE, setOf("clean", "quarantined"))
    )
    val ports: List<GeneratedProductPort> = GeneratedLinkNativeLegoPortData.ports
    val portBindings: List<GeneratedProductPortBinding> = GeneratedLinkNativeLegoPortBindings.bindings
    val demandEdges: List<GeneratedProductDemandEdge> = emptyList()
    val allEdges: Set<GeneratedLinkNativeLegoEdge> = portBindings.mapTo(linkedSetOf()) {
        GeneratedLinkNativeLegoEdge(it.from.value, it.to.value)
    }
}
