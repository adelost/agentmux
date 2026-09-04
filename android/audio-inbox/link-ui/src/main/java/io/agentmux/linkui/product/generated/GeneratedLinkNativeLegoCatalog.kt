// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM the portable native-Lego catalog
// Product declarations SHA-256: 96080f861e9a9fbb95b032b812e0caeb3ecf3d757f6b1628bcdfe983c85c18b8
package io.agentmux.linkui.product.generated

internal enum class GeneratedLinkNodeId(val wireId: String) { NAVIGATION_SERVICE("navigation.service"), CAPTURE_SERVICE("capture.service"), CONVERSATION_SERVICE("conversation.service"), PLAYBACK_SERVICE("playback.service"), TARGET_SERVICE("target.service"), SESSION_SERVICE("session.service"), HISTORY_SERVICE("history.service"), PREFERENCES_SERVICE("preferences.service"), UPDATES_SERVICE("updates.service"), RECOVERY_SERVICE("recovery.service"), CAPTURE_PRESENTATION("capture.presentation"), CONVERSATION_PRESENTATION("conversation.presentation"), PLAYBACK_PRESENTATION("playback.presentation"), TARGET_PRESENTATION("target.presentation"), SESSION_PRESENTATION("session.presentation"), HISTORY_PRESENTATION("history.presentation"), PREFERENCES_PRESENTATION("preferences.presentation"), UPDATES_PRESENTATION("updates.presentation"), RECOVERY_PRESENTATION("recovery.presentation"), CAPTURE_PHASE_PRESENTATION_ADAPTER("capture.phase.presentation-adapter"), CONVERSATION_DELIVERY_PHASE_PRESENTATION_ADAPTER("conversation.delivery-phase.presentation-adapter"), CONVERSATION_REPLY_PHASE_PRESENTATION_ADAPTER("conversation.reply-phase.presentation-adapter"), PLAYBACK_PHASE_PRESENTATION_ADAPTER("playback.phase.presentation-adapter"), TARGET_KIND_PRESENTATION_ADAPTER("target.kind.presentation-adapter"), SESSION_CONNECTION_STATE_PRESENTATION_ADAPTER("session.connection-state.presentation-adapter"), UPDATES_PHASE_PRESENTATION_ADAPTER("updates.phase.presentation-adapter"), RECOVERY_PHASE_PRESENTATION_ADAPTER("recovery.phase.presentation-adapter") }

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
        data object CAPTURE_PHASE_PRESENTATION_ADAPTER_STATE : GeneratedProductInputPortId { override val value = "capture.phase.presentation-adapter.state" }
        data object CAPTURE_PHASE_PRESENTATION_ADAPTER_PRESENTATION : GeneratedProductOutputPortId { override val value = "capture.phase.presentation-adapter.presentation" }
        data object CONVERSATION_DELIVERY_PHASE_PRESENTATION_ADAPTER_STATE : GeneratedProductInputPortId { override val value = "conversation.delivery-phase.presentation-adapter.state" }
        data object CONVERSATION_DELIVERY_PHASE_PRESENTATION_ADAPTER_PRESENTATION : GeneratedProductOutputPortId { override val value = "conversation.delivery-phase.presentation-adapter.presentation" }
        data object CONVERSATION_REPLY_PHASE_PRESENTATION_ADAPTER_STATE : GeneratedProductInputPortId { override val value = "conversation.reply-phase.presentation-adapter.state" }
        data object CONVERSATION_REPLY_PHASE_PRESENTATION_ADAPTER_PRESENTATION : GeneratedProductOutputPortId { override val value = "conversation.reply-phase.presentation-adapter.presentation" }
        data object PLAYBACK_PHASE_PRESENTATION_ADAPTER_STATE : GeneratedProductInputPortId { override val value = "playback.phase.presentation-adapter.state" }
        data object PLAYBACK_PHASE_PRESENTATION_ADAPTER_PRESENTATION : GeneratedProductOutputPortId { override val value = "playback.phase.presentation-adapter.presentation" }
        data object TARGET_KIND_PRESENTATION_ADAPTER_STATE : GeneratedProductInputPortId { override val value = "target.kind.presentation-adapter.state" }
        data object TARGET_KIND_PRESENTATION_ADAPTER_PRESENTATION : GeneratedProductOutputPortId { override val value = "target.kind.presentation-adapter.presentation" }
        data object SESSION_CONNECTION_STATE_PRESENTATION_ADAPTER_STATE : GeneratedProductInputPortId { override val value = "session.connection-state.presentation-adapter.state" }
        data object SESSION_CONNECTION_STATE_PRESENTATION_ADAPTER_PRESENTATION : GeneratedProductOutputPortId { override val value = "session.connection-state.presentation-adapter.presentation" }
        data object UPDATES_PHASE_PRESENTATION_ADAPTER_STATE : GeneratedProductInputPortId { override val value = "updates.phase.presentation-adapter.state" }
        data object UPDATES_PHASE_PRESENTATION_ADAPTER_PRESENTATION : GeneratedProductOutputPortId { override val value = "updates.phase.presentation-adapter.presentation" }
        data object RECOVERY_PHASE_PRESENTATION_ADAPTER_STATE : GeneratedProductInputPortId { override val value = "recovery.phase.presentation-adapter.state" }
        data object RECOVERY_PHASE_PRESENTATION_ADAPTER_PRESENTATION : GeneratedProductOutputPortId { override val value = "recovery.phase.presentation-adapter.presentation" }
        data object NAVIGATION_PAGE_HOST_ACTIVEPAGE : GeneratedProductInputPortId { override val value = "navigation.page-host.activePage" }
        data object TARGET_PICKER_MODEL : GeneratedProductInputPortId { override val value = "target.picker.model" }
        data object TARGET_PICKER_TARGETSTATE : GeneratedProductInputPortId { override val value = "target.picker.targetState" }
        data object TARGET_PICKER_SELECT : GeneratedProductOutputPortId { override val value = "target.picker.select" }
        data object CAPTURE_TALK_MODEL : GeneratedProductInputPortId { override val value = "capture.talk.model" }
        data object CAPTURE_TALK_CAPTURESTATE : GeneratedProductInputPortId { override val value = "capture.talk.captureState" }
        data object CAPTURE_TALK_COMMAND : GeneratedProductOutputPortId { override val value = "capture.talk.command" }
        data object CONVERSATION_LATEST_MODEL : GeneratedProductInputPortId { override val value = "conversation.latest.model" }
        data object CONVERSATION_LATEST_DELIVERYSTATE : GeneratedProductInputPortId { override val value = "conversation.latest.deliveryState" }
        data object CONVERSATION_LATEST_REPLYSTATE : GeneratedProductInputPortId { override val value = "conversation.latest.replyState" }
        data object CONVERSATION_COMPOSER_MODEL : GeneratedProductInputPortId { override val value = "conversation.composer.model" }
        data object CONVERSATION_COMPOSER_DELIVERYSTATE : GeneratedProductInputPortId { override val value = "conversation.composer.deliveryState" }
        data object CONVERSATION_COMPOSER_REPLYSTATE : GeneratedProductInputPortId { override val value = "conversation.composer.replyState" }
        data object CONVERSATION_COMPOSER_COMPOSE : GeneratedProductOutputPortId { override val value = "conversation.composer.compose" }
        data object PLAYBACK_CONTROLS_MODEL : GeneratedProductInputPortId { override val value = "playback.controls.model" }
        data object PLAYBACK_CONTROLS_PLAYBACKSTATE : GeneratedProductInputPortId { override val value = "playback.controls.playbackState" }
        data object PLAYBACK_CONTROLS_COMMAND : GeneratedProductOutputPortId { override val value = "playback.controls.command" }
        data object SESSION_CONNECTION_MODEL : GeneratedProductInputPortId { override val value = "session.connection.model" }
        data object SESSION_CONNECTION_CONNECTIONSTATE : GeneratedProductInputPortId { override val value = "session.connection.connectionState" }
        data object SESSION_PUBLIC_LINK_MODEL : GeneratedProductInputPortId { override val value = "session.public-link.model" }
        data object SESSION_PUBLIC_LINK_CONNECTIONSTATE : GeneratedProductInputPortId { override val value = "session.public-link.connectionState" }
        data object PREFERENCES_TOGGLES_MODEL : GeneratedProductInputPortId { override val value = "preferences.toggles.model" }
        data object PREFERENCES_TOGGLES_TOGGLE : GeneratedProductOutputPortId { override val value = "preferences.toggles.toggle" }
        data object HISTORY_LOCAL_MODEL : GeneratedProductInputPortId { override val value = "history.local.model" }
        data object UPDATES_PANEL_MODEL : GeneratedProductInputPortId { override val value = "updates.panel.model" }
        data object UPDATES_PANEL_UPDATESTATE : GeneratedProductInputPortId { override val value = "updates.panel.updateState" }
        data object UPDATES_PANEL_COMMAND : GeneratedProductOutputPortId { override val value = "updates.panel.command" }
        data object RECOVERY_STATUS_MODEL : GeneratedProductInputPortId { override val value = "recovery.status.model" }
        data object RECOVERY_STATUS_RECOVERYSTATE : GeneratedProductInputPortId { override val value = "recovery.status.recoveryState" }
        data object NAVIGATION_SETTINGS_ENTRY_OPEN : GeneratedProductOutputPortId { override val value = "navigation.settings-entry.open" }
        data object NAVIGATION_DEV_HOST_ENTRY_OPEN : GeneratedProductOutputPortId { override val value = "navigation.dev-host-entry.open" }
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
        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.LINK_CAPTURE_OPERATION, setOf("begin", "release", "cancel")),
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
