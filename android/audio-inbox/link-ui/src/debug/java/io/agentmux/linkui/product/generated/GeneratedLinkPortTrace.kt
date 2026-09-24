// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM the typed Link port-return boundary
// Product declarations SHA-256: 9bd192852b104c02d6f5034f5ce14cd65b0a782174240d027b63a1284f069a7f
package io.agentmux.linkui.product.generated

/** Test recording and an optional debug observer share the same generated port identities. */
internal object GeneratedLinkPortTrace {
    private val output = System.getenv("V1D_STUDIO_TRACE_DIR")?.takeIf { it.isNotBlank() }?.let {
        java.io.File(it, "kotlin-" + java.util.UUID.randomUUID() + ".jsonl")
    }
    @Volatile var observer: ((String) -> Unit)? = null

    @Synchronized fun returned(port: GeneratedProductPortId) {
        val row = when (port) {
        GeneratedLinkNativeLegoCatalog.PortIds.CAPTURE_PHASE_PRESENTATION_ADAPTER_STATE -> "{\"kind\":\"port\",\"portRef\":\"capture.phase.presentation-adapter.state\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.CAPTURE_PRESENTATION_SOURCE -> "{\"kind\":\"port\",\"portRef\":\"capture.presentation.source\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.CAPTURE_TALK_CAPTURESTATE -> "{\"kind\":\"port\",\"portRef\":\"capture.talk.captureState\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.CAPTURE_TALK_COMMAND -> "{\"kind\":\"port\",\"portRef\":\"capture.talk.command\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.CAPTURE_TALK_MODEL -> "{\"kind\":\"port\",\"portRef\":\"capture.talk.model\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.CONVERSATION_COMPOSER_COMPOSE -> "{\"kind\":\"port\",\"portRef\":\"conversation.composer.compose\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.CONVERSATION_COMPOSER_DELIVERYSTATE -> "{\"kind\":\"port\",\"portRef\":\"conversation.composer.deliveryState\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.CONVERSATION_COMPOSER_MODEL -> "{\"kind\":\"port\",\"portRef\":\"conversation.composer.model\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.CONVERSATION_COMPOSER_REPLYSTATE -> "{\"kind\":\"port\",\"portRef\":\"conversation.composer.replyState\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.CONVERSATION_DELIVERY_PHASE_PRESENTATION_ADAPTER_STATE -> "{\"kind\":\"port\",\"portRef\":\"conversation.delivery-phase.presentation-adapter.state\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.CONVERSATION_LATEST_DELIVERYSTATE -> "{\"kind\":\"port\",\"portRef\":\"conversation.latest.deliveryState\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.CONVERSATION_LATEST_MODEL -> "{\"kind\":\"port\",\"portRef\":\"conversation.latest.model\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.CONVERSATION_LATEST_REPLYSTATE -> "{\"kind\":\"port\",\"portRef\":\"conversation.latest.replyState\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.CONVERSATION_PRESENTATION_SOURCE -> "{\"kind\":\"port\",\"portRef\":\"conversation.presentation.source\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.CONVERSATION_REPLY_PHASE_PRESENTATION_ADAPTER_STATE -> "{\"kind\":\"port\",\"portRef\":\"conversation.reply-phase.presentation-adapter.state\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.CONVERSATION_SERVICE_TURN -> "{\"kind\":\"port\",\"portRef\":\"conversation.service.turn\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.HISTORY_LOCAL_CLEAR -> "{\"kind\":\"port\",\"portRef\":\"history.local.clear\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.HISTORY_LOCAL_MODEL -> "{\"kind\":\"port\",\"portRef\":\"history.local.model\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.HISTORY_PRESENTATION_SOURCE -> "{\"kind\":\"port\",\"portRef\":\"history.presentation.source\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.NAVIGATION_DEV_HOST_ENTRY_OPEN -> "{\"kind\":\"port\",\"portRef\":\"navigation.dev-host-entry.open\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.NAVIGATION_PAGE_HOST_ACTIVEPAGE -> "{\"kind\":\"port\",\"portRef\":\"navigation.page-host.activePage\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.NAVIGATION_SETTINGS_ENTRY_OPEN -> "{\"kind\":\"port\",\"portRef\":\"navigation.settings-entry.open\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.NAVIGATION_WAKE_DEBUG_ENTRY_OPEN -> "{\"kind\":\"port\",\"portRef\":\"navigation.wake-debug-entry.open\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.NAVIGATION_WAKE_TRY_ENTRY_OPEN -> "{\"kind\":\"port\",\"portRef\":\"navigation.wake-try-entry.open\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.NAVIGATION_WAKE_TRY_ENTRY_WAKESENSITIVITY -> "{\"kind\":\"port\",\"portRef\":\"navigation.wake-try-entry.wakeSensitivity\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.PLAYBACK_CONTROLS_COMMAND -> "{\"kind\":\"port\",\"portRef\":\"playback.controls.command\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.PLAYBACK_CONTROLS_MODEL -> "{\"kind\":\"port\",\"portRef\":\"playback.controls.model\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.PLAYBACK_CONTROLS_PLAYBACKSTATE -> "{\"kind\":\"port\",\"portRef\":\"playback.controls.playbackState\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.PLAYBACK_PHASE_PRESENTATION_ADAPTER_STATE -> "{\"kind\":\"port\",\"portRef\":\"playback.phase.presentation-adapter.state\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.PLAYBACK_PRESENTATION_SOURCE -> "{\"kind\":\"port\",\"portRef\":\"playback.presentation.source\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.PREFERENCES_PRESENTATION_SOURCE -> "{\"kind\":\"port\",\"portRef\":\"preferences.presentation.source\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.PREFERENCES_TOGGLES_MODEL -> "{\"kind\":\"port\",\"portRef\":\"preferences.toggles.model\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.PREFERENCES_TOGGLES_TOGGLE -> "{\"kind\":\"port\",\"portRef\":\"preferences.toggles.toggle\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.RECOVERY_PHASE_PRESENTATION_ADAPTER_STATE -> "{\"kind\":\"port\",\"portRef\":\"recovery.phase.presentation-adapter.state\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.RECOVERY_PRESENTATION_SOURCE -> "{\"kind\":\"port\",\"portRef\":\"recovery.presentation.source\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.RECOVERY_STATUS_MODEL -> "{\"kind\":\"port\",\"portRef\":\"recovery.status.model\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.RECOVERY_STATUS_RECOVERYSTATE -> "{\"kind\":\"port\",\"portRef\":\"recovery.status.recoveryState\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.SESSION_CONNECTION_STATE_PRESENTATION_ADAPTER_STATE -> "{\"kind\":\"port\",\"portRef\":\"session.connection-state.presentation-adapter.state\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.SESSION_CONNECTION_CONNECTIONSTATE -> "{\"kind\":\"port\",\"portRef\":\"session.connection.connectionState\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.SESSION_CONNECTION_MODEL -> "{\"kind\":\"port\",\"portRef\":\"session.connection.model\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.SESSION_PRESENTATION_SOURCE -> "{\"kind\":\"port\",\"portRef\":\"session.presentation.source\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.SESSION_PUBLIC_LINK_CONNECTIONSTATE -> "{\"kind\":\"port\",\"portRef\":\"session.public-link.connectionState\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.SESSION_PUBLIC_LINK_MODEL -> "{\"kind\":\"port\",\"portRef\":\"session.public-link.model\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.TARGET_KIND_PRESENTATION_ADAPTER_STATE -> "{\"kind\":\"port\",\"portRef\":\"target.kind.presentation-adapter.state\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.TARGET_PICKER_MODEL -> "{\"kind\":\"port\",\"portRef\":\"target.picker.model\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.TARGET_PICKER_SELECT -> "{\"kind\":\"port\",\"portRef\":\"target.picker.select\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.TARGET_PICKER_TARGETSTATE -> "{\"kind\":\"port\",\"portRef\":\"target.picker.targetState\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.TARGET_PRESENTATION_SOURCE -> "{\"kind\":\"port\",\"portRef\":\"target.presentation.source\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.UPDATES_PANEL_COMMAND -> "{\"kind\":\"port\",\"portRef\":\"updates.panel.command\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.UPDATES_PANEL_MODEL -> "{\"kind\":\"port\",\"portRef\":\"updates.panel.model\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.UPDATES_PANEL_UPDATESTATE -> "{\"kind\":\"port\",\"portRef\":\"updates.panel.updateState\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.UPDATES_PHASE_PRESENTATION_ADAPTER_STATE -> "{\"kind\":\"port\",\"portRef\":\"updates.phase.presentation-adapter.state\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.UPDATES_PRESENTATION_SOURCE -> "{\"kind\":\"port\",\"portRef\":\"updates.presentation.source\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.WAKE_PHASE_PRESENTATION_ADAPTER_STATE -> "{\"kind\":\"port\",\"portRef\":\"wake.phase.presentation-adapter.state\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.WAKE_PHRASE_PRESENTATION_ADAPTER_STATE -> "{\"kind\":\"port\",\"portRef\":\"wake.phrase.presentation-adapter.state\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.WAKE_PRESENTATION_SOURCE -> "{\"kind\":\"port\",\"portRef\":\"wake.presentation.source\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.WAKE_SENSITIVITY_PRESENTATION_ADAPTER_STATE -> "{\"kind\":\"port\",\"portRef\":\"wake.sensitivity.presentation-adapter.state\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.WAKE_STATUS_MODEL -> "{\"kind\":\"port\",\"portRef\":\"wake.status.model\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.WAKE_STATUS_WAKEPHRASE -> "{\"kind\":\"port\",\"portRef\":\"wake.status.wakePhrase\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.WAKE_STATUS_WAKESENSITIVITY -> "{\"kind\":\"port\",\"portRef\":\"wake.status.wakeSensitivity\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.WAKE_STATUS_WAKESTATE -> "{\"kind\":\"port\",\"portRef\":\"wake.status.wakeState\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.WAKE_TOGGLE_MODEL -> "{\"kind\":\"port\",\"portRef\":\"wake.toggle.model\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.WAKE_TOGGLE_TOGGLE -> "{\"kind\":\"port\",\"portRef\":\"wake.toggle.toggle\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.WAKE_TOGGLE_WAKEPHRASE -> "{\"kind\":\"port\",\"portRef\":\"wake.toggle.wakePhrase\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.WAKE_TOGGLE_WAKESENSITIVITY -> "{\"kind\":\"port\",\"portRef\":\"wake.toggle.wakeSensitivity\",\"phase\":\"returned\"}"
        GeneratedLinkNativeLegoCatalog.PortIds.WAKE_TOGGLE_WAKESTATE -> "{\"kind\":\"port\",\"portRef\":\"wake.toggle.wakeState\",\"phase\":\"returned\"}"
            else -> return
        }
        try { output?.appendText(row + "\n") } catch (failure: Exception) {
            System.err.println("Link Studio test trace unavailable: " + failure.javaClass.simpleName)
        }
        try { observer?.invoke(row) } catch (failure: Exception) {
            System.err.println("Link Studio observation unavailable: " + failure.javaClass.simpleName)
        }
    }
}
