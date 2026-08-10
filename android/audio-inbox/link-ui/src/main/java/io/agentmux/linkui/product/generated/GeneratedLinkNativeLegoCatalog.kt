// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM the portable native-Lego catalog
// Product declarations SHA-256: 07b65a9ab9c517b883647e79220750a7797e54c3b18da4dff792ae4f9f7cc10f
package io.agentmux.linkui.product.generated

internal enum class GeneratedLinkNodeId(val wireId: String) { NAVIGATION_SERVICE("navigation.service"), CAPTURE_SERVICE("capture.service"), CONVERSATION_SERVICE("conversation.service"), PLAYBACK_SERVICE("playback.service"), TARGET_SERVICE("target.service"), SESSION_SERVICE("session.service"), HOST_SERVICE("host.service"), HISTORY_SERVICE("history.service"), PREFERENCES_SERVICE("preferences.service"), UPDATES_SERVICE("updates.service"), RECOVERY_SERVICE("recovery.service"), CAPTURE_PRESENTATION("capture.presentation"), CONVERSATION_PRESENTATION("conversation.presentation"), PLAYBACK_PRESENTATION("playback.presentation"), TARGET_PRESENTATION("target.presentation"), SESSION_PRESENTATION("session.presentation"), HISTORY_PRESENTATION("history.presentation"), PREFERENCES_PRESENTATION("preferences.presentation"), UPDATES_PRESENTATION("updates.presentation"), RECOVERY_PRESENTATION("recovery.presentation"), LINK_CAPTURE_PHASE_PRESENTATION_ADAPTER("link.capture-phase.presentation-adapter"), LINK_DELIVERY_PHASE_PRESENTATION_ADAPTER("link.delivery-phase.presentation-adapter"), LINK_REPLY_PHASE_PRESENTATION_ADAPTER("link.reply-phase.presentation-adapter"), LINK_PLAYBACK_PHASE_PRESENTATION_ADAPTER("link.playback-phase.presentation-adapter"), LINK_TARGET_KIND_PRESENTATION_ADAPTER("link.target-kind.presentation-adapter"), LINK_CONNECTION_STATE_PRESENTATION_ADAPTER("link.connection-state.presentation-adapter"), LINK_UPDATE_PHASE_PRESENTATION_ADAPTER("link.update-phase.presentation-adapter"), LINK_RECOVERY_PHASE_PRESENTATION_ADAPTER("link.recovery-phase.presentation-adapter") }

internal object GeneratedLinkNativeLegoCatalog {
    object PortIds {
        data object NAVIGATION_SERVICE_OPENSETTINGS : GeneratedProductInputPortId { override val value = "navigation.service.openSettings" }
        data object NAVIGATION_SERVICE_OPENDEVHOST : GeneratedProductInputPortId { override val value = "navigation.service.openDevHost" }
        data object NAVIGATION_SERVICE_ACTIVEPAGE : GeneratedProductOutputPortId { override val value = "navigation.service.activePage" }
        data object CAPTURE_SERVICE_COMMAND : GeneratedProductInputPortId { override val value = "capture.service.command" }
        data object CAPTURE_SERVICE_STATUS : GeneratedProductOutputPortId { override val value = "capture.service.status" }
        data object CAPTURE_SERVICE_CAPTURED : GeneratedProductOutputPortId { override val value = "capture.service.captured" }
        data object CONVERSATION_SERVICE_TURN : GeneratedProductInputPortId { override val value = "conversation.service.turn" }
        data object CONVERSATION_SERVICE_COMPOSE : GeneratedProductInputPortId { override val value = "conversation.service.compose" }
        data object CONVERSATION_SERVICE_EDIT : GeneratedProductInputPortId { override val value = "conversation.service.edit" }
        data object CONVERSATION_SERVICE_STATUS : GeneratedProductOutputPortId { override val value = "conversation.service.status" }
        data object PLAYBACK_SERVICE_COMMAND : GeneratedProductInputPortId { override val value = "playback.service.command" }
        data object PLAYBACK_SERVICE_LATESTCOMMAND : GeneratedProductInputPortId { override val value = "playback.service.latestCommand" }
        data object PLAYBACK_SERVICE_STATUS : GeneratedProductOutputPortId { override val value = "playback.service.status" }
        data object TARGET_SERVICE_SELECT : GeneratedProductInputPortId { override val value = "target.service.select" }
        data object TARGET_SERVICE_DIRECTORY : GeneratedProductOutputPortId { override val value = "target.service.directory" }
        data object SESSION_SERVICE_COMMAND : GeneratedProductInputPortId { override val value = "session.service.command" }
        data object SESSION_SERVICE_STATUS : GeneratedProductOutputPortId { override val value = "session.service.status" }
        data object HOST_SERVICE_OPENATTACHMENT : GeneratedProductInputPortId { override val value = "host.service.openAttachment" }
        data object HISTORY_SERVICE_STATUS : GeneratedProductOutputPortId { override val value = "history.service.status" }
        data object PREFERENCES_SERVICE_TOGGLE : GeneratedProductInputPortId { override val value = "preferences.service.toggle" }
        data object PREFERENCES_SERVICE_STATUS : GeneratedProductOutputPortId { override val value = "preferences.service.status" }
        data object UPDATES_SERVICE_COMMAND : GeneratedProductInputPortId { override val value = "updates.service.command" }
        data object UPDATES_SERVICE_STATUS : GeneratedProductOutputPortId { override val value = "updates.service.status" }
        data object RECOVERY_SERVICE_STATUS : GeneratedProductOutputPortId { override val value = "recovery.service.status" }
        data object CAPTURE_PRESENTATION_SOURCE : GeneratedProductInputPortId { override val value = "capture.presentation.source" }
        data object CAPTURE_PRESENTATION_MODEL : GeneratedProductOutputPortId { override val value = "capture.presentation.model" }
        data object CONVERSATION_PRESENTATION_SOURCE : GeneratedProductInputPortId { override val value = "conversation.presentation.source" }
        data object CONVERSATION_PRESENTATION_MODEL : GeneratedProductOutputPortId { override val value = "conversation.presentation.model" }
        data object PLAYBACK_PRESENTATION_SOURCE : GeneratedProductInputPortId { override val value = "playback.presentation.source" }
        data object PLAYBACK_PRESENTATION_MODEL : GeneratedProductOutputPortId { override val value = "playback.presentation.model" }
        data object TARGET_PRESENTATION_SOURCE : GeneratedProductInputPortId { override val value = "target.presentation.source" }
        data object TARGET_PRESENTATION_MODEL : GeneratedProductOutputPortId { override val value = "target.presentation.model" }
        data object SESSION_PRESENTATION_SOURCE : GeneratedProductInputPortId { override val value = "session.presentation.source" }
        data object SESSION_PRESENTATION_MODEL : GeneratedProductOutputPortId { override val value = "session.presentation.model" }
        data object HISTORY_PRESENTATION_SOURCE : GeneratedProductInputPortId { override val value = "history.presentation.source" }
        data object HISTORY_PRESENTATION_MODEL : GeneratedProductOutputPortId { override val value = "history.presentation.model" }
        data object PREFERENCES_PRESENTATION_SOURCE : GeneratedProductInputPortId { override val value = "preferences.presentation.source" }
        data object PREFERENCES_PRESENTATION_MODEL : GeneratedProductOutputPortId { override val value = "preferences.presentation.model" }
        data object UPDATES_PRESENTATION_SOURCE : GeneratedProductInputPortId { override val value = "updates.presentation.source" }
        data object UPDATES_PRESENTATION_MODEL : GeneratedProductOutputPortId { override val value = "updates.presentation.model" }
        data object RECOVERY_PRESENTATION_SOURCE : GeneratedProductInputPortId { override val value = "recovery.presentation.source" }
        data object RECOVERY_PRESENTATION_MODEL : GeneratedProductOutputPortId { override val value = "recovery.presentation.model" }
        data object LINK_CAPTURE_PHASE_PRESENTATION_ADAPTER_STATE : GeneratedProductInputPortId { override val value = "link.capture-phase.presentation-adapter.state" }
        data object LINK_CAPTURE_PHASE_PRESENTATION_ADAPTER_PRESENTATION : GeneratedProductOutputPortId { override val value = "link.capture-phase.presentation-adapter.presentation" }
        data object LINK_DELIVERY_PHASE_PRESENTATION_ADAPTER_STATE : GeneratedProductInputPortId { override val value = "link.delivery-phase.presentation-adapter.state" }
        data object LINK_DELIVERY_PHASE_PRESENTATION_ADAPTER_PRESENTATION : GeneratedProductOutputPortId { override val value = "link.delivery-phase.presentation-adapter.presentation" }
        data object LINK_REPLY_PHASE_PRESENTATION_ADAPTER_STATE : GeneratedProductInputPortId { override val value = "link.reply-phase.presentation-adapter.state" }
        data object LINK_REPLY_PHASE_PRESENTATION_ADAPTER_PRESENTATION : GeneratedProductOutputPortId { override val value = "link.reply-phase.presentation-adapter.presentation" }
        data object LINK_PLAYBACK_PHASE_PRESENTATION_ADAPTER_STATE : GeneratedProductInputPortId { override val value = "link.playback-phase.presentation-adapter.state" }
        data object LINK_PLAYBACK_PHASE_PRESENTATION_ADAPTER_PRESENTATION : GeneratedProductOutputPortId { override val value = "link.playback-phase.presentation-adapter.presentation" }
        data object LINK_TARGET_KIND_PRESENTATION_ADAPTER_STATE : GeneratedProductInputPortId { override val value = "link.target-kind.presentation-adapter.state" }
        data object LINK_TARGET_KIND_PRESENTATION_ADAPTER_PRESENTATION : GeneratedProductOutputPortId { override val value = "link.target-kind.presentation-adapter.presentation" }
        data object LINK_CONNECTION_STATE_PRESENTATION_ADAPTER_STATE : GeneratedProductInputPortId { override val value = "link.connection-state.presentation-adapter.state" }
        data object LINK_CONNECTION_STATE_PRESENTATION_ADAPTER_PRESENTATION : GeneratedProductOutputPortId { override val value = "link.connection-state.presentation-adapter.presentation" }
        data object LINK_UPDATE_PHASE_PRESENTATION_ADAPTER_STATE : GeneratedProductInputPortId { override val value = "link.update-phase.presentation-adapter.state" }
        data object LINK_UPDATE_PHASE_PRESENTATION_ADAPTER_PRESENTATION : GeneratedProductOutputPortId { override val value = "link.update-phase.presentation-adapter.presentation" }
        data object LINK_RECOVERY_PHASE_PRESENTATION_ADAPTER_STATE : GeneratedProductInputPortId { override val value = "link.recovery-phase.presentation-adapter.state" }
        data object LINK_RECOVERY_PHASE_PRESENTATION_ADAPTER_PRESENTATION : GeneratedProductOutputPortId { override val value = "link.recovery-phase.presentation-adapter.presentation" }
        data object PAGE_HOST_ACTIVEPAGE : GeneratedProductInputPortId { override val value = "page-host.activePage" }
        data object TARGET_MODEL : GeneratedProductInputPortId { override val value = "target.model" }
        data object TARGET_TARGETSTATE : GeneratedProductInputPortId { override val value = "target.targetState" }
        data object TARGET_SESSION : GeneratedProductInputPortId { override val value = "target.session" }
        data object TARGET_CONNECTIONSTATE : GeneratedProductInputPortId { override val value = "target.connectionState" }
        data object TARGET_RECOVERY : GeneratedProductInputPortId { override val value = "target.recovery" }
        data object TARGET_RECOVERYSTATE : GeneratedProductInputPortId { override val value = "target.recoveryState" }
        data object TARGET_SELECT : GeneratedProductOutputPortId { override val value = "target.select" }
        data object TALK_MODEL : GeneratedProductInputPortId { override val value = "talk.model" }
        data object TALK_CAPTURESTATE : GeneratedProductInputPortId { override val value = "talk.captureState" }
        data object TALK_COMMAND : GeneratedProductOutputPortId { override val value = "talk.command" }
        data object LATEST_MODEL : GeneratedProductInputPortId { override val value = "latest.model" }
        data object LATEST_DELIVERYSTATE : GeneratedProductInputPortId { override val value = "latest.deliveryState" }
        data object LATEST_REPLYSTATE : GeneratedProductInputPortId { override val value = "latest.replyState" }
        data object LATEST_PLAYBACK : GeneratedProductInputPortId { override val value = "latest.playback" }
        data object LATEST_PLAYBACKSTATE : GeneratedProductInputPortId { override val value = "latest.playbackState" }
        data object LATEST_PLAYBACKCOMMAND : GeneratedProductOutputPortId { override val value = "latest.playbackCommand" }
        data object LATEST_OPENATTACHMENT : GeneratedProductOutputPortId { override val value = "latest.openAttachment" }
        data object COMPOSER_MODEL : GeneratedProductInputPortId { override val value = "composer.model" }
        data object COMPOSER_DELIVERYSTATE : GeneratedProductInputPortId { override val value = "composer.deliveryState" }
        data object COMPOSER_REPLYSTATE : GeneratedProductInputPortId { override val value = "composer.replyState" }
        data object COMPOSER_TARGET : GeneratedProductInputPortId { override val value = "composer.target" }
        data object COMPOSER_TARGETSTATE : GeneratedProductInputPortId { override val value = "composer.targetState" }
        data object COMPOSER_COMPOSE : GeneratedProductOutputPortId { override val value = "composer.compose" }
        data object COMPOSER_EDIT : GeneratedProductOutputPortId { override val value = "composer.edit" }
        data object ACTIVE_PLAYBACK_MODEL : GeneratedProductInputPortId { override val value = "active-playback.model" }
        data object ACTIVE_PLAYBACK_PLAYBACKSTATE : GeneratedProductInputPortId { override val value = "active-playback.playbackState" }
        data object ACTIVE_PLAYBACK_COMMAND : GeneratedProductOutputPortId { override val value = "active-playback.command" }
        data object CONNECTION_MODEL : GeneratedProductInputPortId { override val value = "connection.model" }
        data object CONNECTION_CONNECTIONSTATE : GeneratedProductInputPortId { override val value = "connection.connectionState" }
        data object PUBLIC_LINK_MODEL : GeneratedProductInputPortId { override val value = "public-link.model" }
        data object PUBLIC_LINK_CONNECTIONSTATE : GeneratedProductInputPortId { override val value = "public-link.connectionState" }
        data object PUBLIC_LINK_COMMAND : GeneratedProductOutputPortId { override val value = "public-link.command" }
        data object PREFERENCES_MODEL : GeneratedProductInputPortId { override val value = "preferences.model" }
        data object PREFERENCES_TOGGLE : GeneratedProductOutputPortId { override val value = "preferences.toggle" }
        data object LOCAL_HISTORY_MODEL : GeneratedProductInputPortId { override val value = "local-history.model" }
        data object UPDATES_MODEL : GeneratedProductInputPortId { override val value = "updates.model" }
        data object UPDATES_UPDATESTATE : GeneratedProductInputPortId { override val value = "updates.updateState" }
        data object UPDATES_COMMAND : GeneratedProductOutputPortId { override val value = "updates.command" }
        data object RECOVERY_MODEL : GeneratedProductInputPortId { override val value = "recovery.model" }
        data object RECOVERY_RECOVERYSTATE : GeneratedProductInputPortId { override val value = "recovery.recoveryState" }
        data object SETTINGS_ACTION_OPEN : GeneratedProductOutputPortId { override val value = "settings-action.open" }
        data object DEV_HOST_OPEN : GeneratedProductOutputPortId { override val value = "dev-host.open" }
    }
    object FiniteValueIds {
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
        data object LINK_NAVIGATION_PAGE : GeneratedLinkFiniteValueId { override val value = "link.navigation.page" }
    }
    val finiteValues: List<GeneratedLinkFiniteValueDeclaration> = listOf(
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_CAPTURE_OPERATION, setOf("begin", "release", "cancel", "recover")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_CAPTURE_PHASE, setOf("idle", "listening", "finalizing", "failed")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_DELIVERY_PHASE, setOf("none", "sending", "queued", "failed")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_REPLY_PHASE, setOf("none", "thinking", "ready", "failed")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_PLAYBACK_OPERATION, setOf("play", "pause", "resume", "stop")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_PLAYBACK_PHASE, setOf("idle", "queued", "playing", "paused", "stopped", "played", "skipped", "failed")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_TARGET_KIND, setOf("none", "agent", "windows", "public")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_CONNECTION_STATE, setOf("off", "connecting", "connected", "disconnected", "configuration-required")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_PREFERENCE_KEY, setOf("hands-free", "speak-replies")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_UPDATE_OPERATION, setOf("check", "retry", "install")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_UPDATE_PHASE, setOf("idle", "checking", "up-to-date", "unavailable", "available", "downloading", "ready-to-install", "installing", "install-failed", "failed")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_RECOVERY_PHASE, setOf("clean", "quarantined")),
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_NAVIGATION_PAGE, setOf("home", "settings", "dev-host"))
    )
    val ports: List<GeneratedProductPort> = GeneratedLinkNativeLegoPortData.ports
    val portBindings: List<GeneratedProductPortBinding> = GeneratedLinkNativeLegoPortBindings.bindings
    val demandEdges: List<GeneratedProductDemandEdge> = emptyList()
    val allEdges: Set<GeneratedLinkNativeLegoEdge> = portBindings.mapTo(linkedSetOf()) {
        GeneratedLinkNativeLegoEdge(it.from.value, it.to.value)
    }
}
