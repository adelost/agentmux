// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM ProductIr.componentRenderContracts
// Product declarations SHA-256: 9cd226c5d42a0e5712b6e809e6bf5b31e8db6c935994e58b92ffcc21e2d0797f
package io.agentmux.linkui.product.generated

import io.agentmux.linkui.product.*

data class GeneratedLinkRendererIdentity(
    val instanceRef: String,
    val typeRef: String,
)
data class GeneratedLinkRendererScope(
    val component: GeneratedLinkComponentId,
    val artifact: GeneratedLinkArtifactRef,
    val page: GeneratedLinkPageId,
    val surface: String,
    val mountRef: String,
)
data class GeneratedLinkRendererInput(
    val component: GeneratedLinkComponentId,
    val inputPortRef: String,
    val producerPortRef: String,
    val contractRef: String,
    val required: Boolean,
)
data class GeneratedLinkRendererEvent(
    val component: GeneratedLinkComponentId,
    val eventPortRef: String,
    val targetPortRef: String,
    val contractRef: String,
)

enum class GeneratedLinkRendererScopeId(val declaration: GeneratedLinkRendererScope) {
    PAGE_HOST_PHONE_FULL_UI_HOME_ROUND_PAGE_HOST(GeneratedLinkRendererScope(GeneratedLinkComponentId.PAGE_HOST, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.HOME, "round", "page-host")),
    PAGE_HOST_PHONE_FULL_UI_HOME_COMPACT_PAGE_HOST(GeneratedLinkRendererScope(GeneratedLinkComponentId.PAGE_HOST, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.HOME, "compact", "page-host")),
    PAGE_HOST_PHONE_FULL_UI_HOME_WIDE_PAGE_HOST(GeneratedLinkRendererScope(GeneratedLinkComponentId.PAGE_HOST, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.HOME, "wide", "page-host")),
    PAGE_HOST_PHONE_FULL_UI_SETTINGS_ROUND_PAGE_HOST(GeneratedLinkRendererScope(GeneratedLinkComponentId.PAGE_HOST, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "round", "page-host")),
    PAGE_HOST_PHONE_FULL_UI_SETTINGS_COMPACT_PAGE_HOST(GeneratedLinkRendererScope(GeneratedLinkComponentId.PAGE_HOST, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "compact", "page-host")),
    PAGE_HOST_PHONE_FULL_UI_SETTINGS_WIDE_PAGE_HOST(GeneratedLinkRendererScope(GeneratedLinkComponentId.PAGE_HOST, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "wide", "page-host")),
    PAGE_HOST_PHONE_FULL_UI_DEV_HOST_ROUND_PAGE_HOST(GeneratedLinkRendererScope(GeneratedLinkComponentId.PAGE_HOST, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.DEV_HOST, "round", "page-host")),
    PAGE_HOST_PHONE_FULL_UI_DEV_HOST_COMPACT_PAGE_HOST(GeneratedLinkRendererScope(GeneratedLinkComponentId.PAGE_HOST, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.DEV_HOST, "compact", "page-host")),
    PAGE_HOST_PHONE_FULL_UI_DEV_HOST_WIDE_PAGE_HOST(GeneratedLinkRendererScope(GeneratedLinkComponentId.PAGE_HOST, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.DEV_HOST, "wide", "page-host")),
    PAGE_HOST_WEAR_FULL_UI_HOME_ROUND_PAGE_HOST(GeneratedLinkRendererScope(GeneratedLinkComponentId.PAGE_HOST, GeneratedLinkArtifactRef.WEAR_FULL_UI, GeneratedLinkPageId.HOME, "round", "page-host")),
    PAGE_HOST_WEAR_FULL_UI_SETTINGS_ROUND_PAGE_HOST(GeneratedLinkRendererScope(GeneratedLinkComponentId.PAGE_HOST, GeneratedLinkArtifactRef.WEAR_FULL_UI, GeneratedLinkPageId.SETTINGS, "round", "page-host")),
    TARGET_PHONE_FULL_UI_HOME_ROUND_TARGET(GeneratedLinkRendererScope(GeneratedLinkComponentId.TARGET, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.HOME, "round", "target")),
    TARGET_PHONE_FULL_UI_HOME_COMPACT_TARGET(GeneratedLinkRendererScope(GeneratedLinkComponentId.TARGET, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.HOME, "compact", "target")),
    TARGET_PHONE_FULL_UI_HOME_WIDE_TARGET(GeneratedLinkRendererScope(GeneratedLinkComponentId.TARGET, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.HOME, "wide", "target")),
    TARGET_WEAR_FULL_UI_HOME_ROUND_TARGET(GeneratedLinkRendererScope(GeneratedLinkComponentId.TARGET, GeneratedLinkArtifactRef.WEAR_FULL_UI, GeneratedLinkPageId.HOME, "round", "target")),
    TALK_PHONE_FULL_UI_HOME_ROUND_TALK(GeneratedLinkRendererScope(GeneratedLinkComponentId.TALK, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.HOME, "round", "talk")),
    TALK_PHONE_FULL_UI_HOME_COMPACT_TALK(GeneratedLinkRendererScope(GeneratedLinkComponentId.TALK, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.HOME, "compact", "talk")),
    TALK_PHONE_FULL_UI_HOME_WIDE_TALK(GeneratedLinkRendererScope(GeneratedLinkComponentId.TALK, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.HOME, "wide", "talk")),
    TALK_WEAR_FULL_UI_HOME_ROUND_TALK(GeneratedLinkRendererScope(GeneratedLinkComponentId.TALK, GeneratedLinkArtifactRef.WEAR_FULL_UI, GeneratedLinkPageId.HOME, "round", "talk")),
    LATEST_PHONE_FULL_UI_HOME_ROUND_LATEST(GeneratedLinkRendererScope(GeneratedLinkComponentId.LATEST, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.HOME, "round", "latest")),
    LATEST_PHONE_FULL_UI_HOME_COMPACT_LATEST(GeneratedLinkRendererScope(GeneratedLinkComponentId.LATEST, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.HOME, "compact", "latest")),
    LATEST_PHONE_FULL_UI_HOME_WIDE_LATEST(GeneratedLinkRendererScope(GeneratedLinkComponentId.LATEST, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.HOME, "wide", "latest")),
    LATEST_WEAR_FULL_UI_HOME_ROUND_LATEST(GeneratedLinkRendererScope(GeneratedLinkComponentId.LATEST, GeneratedLinkArtifactRef.WEAR_FULL_UI, GeneratedLinkPageId.HOME, "round", "latest")),
    COMPOSER_PHONE_FULL_UI_HOME_COMPACT_COMPOSER(GeneratedLinkRendererScope(GeneratedLinkComponentId.COMPOSER, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.HOME, "compact", "composer")),
    COMPOSER_PHONE_FULL_UI_HOME_WIDE_COMPOSER(GeneratedLinkRendererScope(GeneratedLinkComponentId.COMPOSER, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.HOME, "wide", "composer")),
    ACTIVE_PLAYBACK_PHONE_FULL_UI_SETTINGS_COMPACT_ACTIVE_PLAYBACK(GeneratedLinkRendererScope(GeneratedLinkComponentId.ACTIVE_PLAYBACK, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "compact", "active-playback")),
    ACTIVE_PLAYBACK_PHONE_FULL_UI_SETTINGS_WIDE_ACTIVE_PLAYBACK(GeneratedLinkRendererScope(GeneratedLinkComponentId.ACTIVE_PLAYBACK, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "wide", "active-playback")),
    CONNECTION_PHONE_FULL_UI_SETTINGS_ROUND_CONNECTION(GeneratedLinkRendererScope(GeneratedLinkComponentId.CONNECTION, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "round", "connection")),
    CONNECTION_PHONE_FULL_UI_SETTINGS_COMPACT_CONNECTION(GeneratedLinkRendererScope(GeneratedLinkComponentId.CONNECTION, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "compact", "connection")),
    CONNECTION_PHONE_FULL_UI_SETTINGS_WIDE_CONNECTION(GeneratedLinkRendererScope(GeneratedLinkComponentId.CONNECTION, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "wide", "connection")),
    CONNECTION_WEAR_FULL_UI_SETTINGS_ROUND_CONNECTION(GeneratedLinkRendererScope(GeneratedLinkComponentId.CONNECTION, GeneratedLinkArtifactRef.WEAR_FULL_UI, GeneratedLinkPageId.SETTINGS, "round", "connection")),
    PUBLIC_LINK_PHONE_FULL_UI_SETTINGS_COMPACT_PUBLIC_LINK(GeneratedLinkRendererScope(GeneratedLinkComponentId.PUBLIC_LINK, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "compact", "public-link")),
    PUBLIC_LINK_PHONE_FULL_UI_SETTINGS_WIDE_PUBLIC_LINK(GeneratedLinkRendererScope(GeneratedLinkComponentId.PUBLIC_LINK, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "wide", "public-link")),
    PREFERENCES_PHONE_FULL_UI_SETTINGS_COMPACT_PREFERENCES(GeneratedLinkRendererScope(GeneratedLinkComponentId.PREFERENCES, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "compact", "preferences")),
    PREFERENCES_PHONE_FULL_UI_SETTINGS_WIDE_PREFERENCES(GeneratedLinkRendererScope(GeneratedLinkComponentId.PREFERENCES, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "wide", "preferences")),
    LOCAL_HISTORY_PHONE_FULL_UI_SETTINGS_COMPACT_LOCAL_HISTORY(GeneratedLinkRendererScope(GeneratedLinkComponentId.LOCAL_HISTORY, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "compact", "local-history")),
    LOCAL_HISTORY_PHONE_FULL_UI_SETTINGS_WIDE_LOCAL_HISTORY(GeneratedLinkRendererScope(GeneratedLinkComponentId.LOCAL_HISTORY, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "wide", "local-history")),
    UPDATES_PHONE_FULL_UI_SETTINGS_ROUND_UPDATES(GeneratedLinkRendererScope(GeneratedLinkComponentId.UPDATES, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "round", "updates")),
    UPDATES_PHONE_FULL_UI_SETTINGS_COMPACT_UPDATES(GeneratedLinkRendererScope(GeneratedLinkComponentId.UPDATES, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "compact", "updates")),
    UPDATES_PHONE_FULL_UI_SETTINGS_WIDE_UPDATES(GeneratedLinkRendererScope(GeneratedLinkComponentId.UPDATES, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "wide", "updates")),
    UPDATES_WEAR_FULL_UI_SETTINGS_ROUND_UPDATES(GeneratedLinkRendererScope(GeneratedLinkComponentId.UPDATES, GeneratedLinkArtifactRef.WEAR_FULL_UI, GeneratedLinkPageId.SETTINGS, "round", "updates")),
    RECOVERY_PHONE_FULL_UI_SETTINGS_ROUND_RECOVERY(GeneratedLinkRendererScope(GeneratedLinkComponentId.RECOVERY, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "round", "recovery")),
    RECOVERY_PHONE_FULL_UI_SETTINGS_COMPACT_RECOVERY(GeneratedLinkRendererScope(GeneratedLinkComponentId.RECOVERY, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "compact", "recovery")),
    RECOVERY_PHONE_FULL_UI_SETTINGS_WIDE_RECOVERY(GeneratedLinkRendererScope(GeneratedLinkComponentId.RECOVERY, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "wide", "recovery")),
    RECOVERY_WEAR_FULL_UI_SETTINGS_ROUND_RECOVERY(GeneratedLinkRendererScope(GeneratedLinkComponentId.RECOVERY, GeneratedLinkArtifactRef.WEAR_FULL_UI, GeneratedLinkPageId.SETTINGS, "round", "recovery")),
    SETTINGS_ACTION_PHONE_FULL_UI_HOME_ROUND_SETTINGS_ACTION(GeneratedLinkRendererScope(GeneratedLinkComponentId.SETTINGS_ACTION, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.HOME, "round", "settings-action")),
    SETTINGS_ACTION_PHONE_FULL_UI_HOME_COMPACT_SETTINGS_ACTION(GeneratedLinkRendererScope(GeneratedLinkComponentId.SETTINGS_ACTION, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.HOME, "compact", "settings-action")),
    SETTINGS_ACTION_PHONE_FULL_UI_HOME_WIDE_SETTINGS_ACTION(GeneratedLinkRendererScope(GeneratedLinkComponentId.SETTINGS_ACTION, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.HOME, "wide", "settings-action")),
    SETTINGS_ACTION_WEAR_FULL_UI_HOME_ROUND_SETTINGS_ACTION(GeneratedLinkRendererScope(GeneratedLinkComponentId.SETTINGS_ACTION, GeneratedLinkArtifactRef.WEAR_FULL_UI, GeneratedLinkPageId.HOME, "round", "settings-action")),
    DEV_HOST_PHONE_FULL_UI_SETTINGS_ROUND_DEV_HOST(GeneratedLinkRendererScope(GeneratedLinkComponentId.DEV_HOST, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "round", "dev-host")),
    DEV_HOST_PHONE_FULL_UI_SETTINGS_COMPACT_DEV_HOST(GeneratedLinkRendererScope(GeneratedLinkComponentId.DEV_HOST, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "compact", "dev-host")),
    DEV_HOST_PHONE_FULL_UI_SETTINGS_WIDE_DEV_HOST(GeneratedLinkRendererScope(GeneratedLinkComponentId.DEV_HOST, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.SETTINGS, "wide", "dev-host")),
    DEV_PREVIEW_PHONE_FULL_UI_DEV_HOST_ROUND_DEV_PREVIEW(GeneratedLinkRendererScope(GeneratedLinkComponentId.DEV_PREVIEW, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.DEV_HOST, "round", "dev-preview")),
    DEV_PREVIEW_PHONE_FULL_UI_DEV_HOST_COMPACT_DEV_PREVIEW(GeneratedLinkRendererScope(GeneratedLinkComponentId.DEV_PREVIEW, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.DEV_HOST, "compact", "dev-preview")),
    DEV_PREVIEW_PHONE_FULL_UI_DEV_HOST_WIDE_DEV_PREVIEW(GeneratedLinkRendererScope(GeneratedLinkComponentId.DEV_PREVIEW, GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkPageId.DEV_HOST, "wide", "dev-preview")),
}
enum class GeneratedLinkRendererInputId(val declaration: GeneratedLinkRendererInput) {
    PAGE_HOST_ACTIVEPAGE(GeneratedLinkRendererInput(GeneratedLinkComponentId.PAGE_HOST, "page-host.activePage", "navigation.service.activePage", "link.navigation.active-page", true)),
    TARGET_MODEL(GeneratedLinkRendererInput(GeneratedLinkComponentId.TARGET, "target.model", "target.presentation.model", "link.target-directory", true)),
    TARGET_TARGETSTATE(GeneratedLinkRendererInput(GeneratedLinkComponentId.TARGET, "target.targetState", "link.target-kind.presentation-adapter.presentation", "link.target-kind.payload", true)),
    TARGET_SESSION(GeneratedLinkRendererInput(GeneratedLinkComponentId.TARGET, "target.session", "session.presentation.model", "link.session-status", true)),
    TARGET_CONNECTIONSTATE(GeneratedLinkRendererInput(GeneratedLinkComponentId.TARGET, "target.connectionState", "link.connection-state.presentation-adapter.presentation", "link.connection-state.payload", true)),
    TARGET_RECOVERY(GeneratedLinkRendererInput(GeneratedLinkComponentId.TARGET, "target.recovery", "recovery.presentation.model", "link.recovery-status", true)),
    TARGET_RECOVERYSTATE(GeneratedLinkRendererInput(GeneratedLinkComponentId.TARGET, "target.recoveryState", "link.recovery-phase.presentation-adapter.presentation", "link.recovery-phase.payload", true)),
    TALK_MODEL(GeneratedLinkRendererInput(GeneratedLinkComponentId.TALK, "talk.model", "capture.presentation.model", "link.capture-status", true)),
    TALK_CAPTURESTATE(GeneratedLinkRendererInput(GeneratedLinkComponentId.TALK, "talk.captureState", "link.capture-phase.presentation-adapter.presentation", "link.capture-phase.payload", true)),
    LATEST_MODEL(GeneratedLinkRendererInput(GeneratedLinkComponentId.LATEST, "latest.model", "conversation.presentation.model", "link.conversation-status", true)),
    LATEST_DELIVERYSTATE(GeneratedLinkRendererInput(GeneratedLinkComponentId.LATEST, "latest.deliveryState", "link.delivery-phase.presentation-adapter.presentation", "link.delivery-phase.payload", true)),
    LATEST_REPLYSTATE(GeneratedLinkRendererInput(GeneratedLinkComponentId.LATEST, "latest.replyState", "link.reply-phase.presentation-adapter.presentation", "link.reply-phase.payload", true)),
    LATEST_PLAYBACK(GeneratedLinkRendererInput(GeneratedLinkComponentId.LATEST, "latest.playback", "playback.presentation.model", "link.playback-status", true)),
    LATEST_PLAYBACKSTATE(GeneratedLinkRendererInput(GeneratedLinkComponentId.LATEST, "latest.playbackState", "link.playback-phase.presentation-adapter.presentation", "link.playback-phase.payload", true)),
    COMPOSER_MODEL(GeneratedLinkRendererInput(GeneratedLinkComponentId.COMPOSER, "composer.model", "conversation.presentation.model", "link.conversation-status", true)),
    COMPOSER_DELIVERYSTATE(GeneratedLinkRendererInput(GeneratedLinkComponentId.COMPOSER, "composer.deliveryState", "link.delivery-phase.presentation-adapter.presentation", "link.delivery-phase.payload", true)),
    COMPOSER_REPLYSTATE(GeneratedLinkRendererInput(GeneratedLinkComponentId.COMPOSER, "composer.replyState", "link.reply-phase.presentation-adapter.presentation", "link.reply-phase.payload", true)),
    COMPOSER_TARGET(GeneratedLinkRendererInput(GeneratedLinkComponentId.COMPOSER, "composer.target", "target.presentation.model", "link.target-directory", true)),
    COMPOSER_TARGETSTATE(GeneratedLinkRendererInput(GeneratedLinkComponentId.COMPOSER, "composer.targetState", "link.target-kind.presentation-adapter.presentation", "link.target-kind.payload", true)),
    ACTIVE_PLAYBACK_MODEL(GeneratedLinkRendererInput(GeneratedLinkComponentId.ACTIVE_PLAYBACK, "active-playback.model", "playback.presentation.model", "link.playback-status", true)),
    ACTIVE_PLAYBACK_PLAYBACKSTATE(GeneratedLinkRendererInput(GeneratedLinkComponentId.ACTIVE_PLAYBACK, "active-playback.playbackState", "link.playback-phase.presentation-adapter.presentation", "link.playback-phase.payload", true)),
    CONNECTION_MODEL(GeneratedLinkRendererInput(GeneratedLinkComponentId.CONNECTION, "connection.model", "session.presentation.model", "link.session-status", true)),
    CONNECTION_CONNECTIONSTATE(GeneratedLinkRendererInput(GeneratedLinkComponentId.CONNECTION, "connection.connectionState", "link.connection-state.presentation-adapter.presentation", "link.connection-state.payload", true)),
    PUBLIC_LINK_MODEL(GeneratedLinkRendererInput(GeneratedLinkComponentId.PUBLIC_LINK, "public-link.model", "session.presentation.model", "link.session-status", true)),
    PUBLIC_LINK_CONNECTIONSTATE(GeneratedLinkRendererInput(GeneratedLinkComponentId.PUBLIC_LINK, "public-link.connectionState", "link.connection-state.presentation-adapter.presentation", "link.connection-state.payload", true)),
    PREFERENCES_MODEL(GeneratedLinkRendererInput(GeneratedLinkComponentId.PREFERENCES, "preferences.model", "preferences.presentation.model", "link.preferences-status", true)),
    LOCAL_HISTORY_MODEL(GeneratedLinkRendererInput(GeneratedLinkComponentId.LOCAL_HISTORY, "local-history.model", "history.presentation.model", "link.history-status", true)),
    UPDATES_MODEL(GeneratedLinkRendererInput(GeneratedLinkComponentId.UPDATES, "updates.model", "updates.presentation.model", "link.update-status", true)),
    UPDATES_UPDATESTATE(GeneratedLinkRendererInput(GeneratedLinkComponentId.UPDATES, "updates.updateState", "link.update-phase.presentation-adapter.presentation", "link.update-phase.payload", true)),
    RECOVERY_MODEL(GeneratedLinkRendererInput(GeneratedLinkComponentId.RECOVERY, "recovery.model", "recovery.presentation.model", "link.recovery-status", true)),
    RECOVERY_RECOVERYSTATE(GeneratedLinkRendererInput(GeneratedLinkComponentId.RECOVERY, "recovery.recoveryState", "link.recovery-phase.presentation-adapter.presentation", "link.recovery-phase.payload", true)),
}
enum class GeneratedLinkRendererEventId(val declaration: GeneratedLinkRendererEvent) {
    TARGET_SELECT(GeneratedLinkRendererEvent(GeneratedLinkComponentId.TARGET, "target.select", "target.service.select", "link.target-select")),
    TALK_COMMAND(GeneratedLinkRendererEvent(GeneratedLinkComponentId.TALK, "talk.command", "capture.service.command", "link.capture-command")),
    LATEST_PLAYBACKCOMMAND(GeneratedLinkRendererEvent(GeneratedLinkComponentId.LATEST, "latest.playbackCommand", "playback.service.latestCommand", "link.playback-command")),
    LATEST_OPENATTACHMENT(GeneratedLinkRendererEvent(GeneratedLinkComponentId.LATEST, "latest.openAttachment", "host.service.openAttachment", "link.open-attachment")),
    COMPOSER_COMPOSE(GeneratedLinkRendererEvent(GeneratedLinkComponentId.COMPOSER, "composer.compose", "conversation.service.compose", "link.compose-turn")),
    COMPOSER_EDIT(GeneratedLinkRendererEvent(GeneratedLinkComponentId.COMPOSER, "composer.edit", "conversation.service.edit", "link.edit-composer")),
    ACTIVE_PLAYBACK_COMMAND(GeneratedLinkRendererEvent(GeneratedLinkComponentId.ACTIVE_PLAYBACK, "active-playback.command", "playback.service.command", "link.playback-command")),
    PUBLIC_LINK_COMMAND(GeneratedLinkRendererEvent(GeneratedLinkComponentId.PUBLIC_LINK, "public-link.command", "session.service.command", "link.public-link-command")),
    PREFERENCES_TOGGLE(GeneratedLinkRendererEvent(GeneratedLinkComponentId.PREFERENCES, "preferences.toggle", "preferences.service.toggle", "link.preference-toggle")),
    UPDATES_COMMAND(GeneratedLinkRendererEvent(GeneratedLinkComponentId.UPDATES, "updates.command", "updates.service.command", "link.update-command")),
    SETTINGS_ACTION_OPEN(GeneratedLinkRendererEvent(GeneratedLinkComponentId.SETTINGS_ACTION, "settings-action.open", "navigation.service.openSettings", "link.navigation.route-intent")),
    DEV_HOST_OPEN(GeneratedLinkRendererEvent(GeneratedLinkComponentId.DEV_HOST, "dev-host.open", "navigation.service.openDevHost", "link.navigation.route-intent")),
}
object GeneratedLinkRendererIdentities {
    val PAGE_HOST = GeneratedLinkRendererIdentity("page-host", "link.page-host")
    val TARGET = GeneratedLinkRendererIdentity("target", "link.target-picker")
    val TALK = GeneratedLinkRendererIdentity("talk", "link.talk")
    val LATEST = GeneratedLinkRendererIdentity("latest", "link.latest-turn")
    val COMPOSER = GeneratedLinkRendererIdentity("composer", "link.composer")
    val ACTIVE_PLAYBACK = GeneratedLinkRendererIdentity("active-playback", "link.active-playback")
    val CONNECTION = GeneratedLinkRendererIdentity("connection", "link.connection-status")
    val PUBLIC_LINK = GeneratedLinkRendererIdentity("public-link", "link.public-link")
    val PREFERENCES = GeneratedLinkRendererIdentity("preferences", "link.preferences")
    val LOCAL_HISTORY = GeneratedLinkRendererIdentity("local-history", "link.local-history")
    val UPDATES = GeneratedLinkRendererIdentity("updates", "link.updates")
    val RECOVERY = GeneratedLinkRendererIdentity("recovery", "link.recovery-status")
    val SETTINGS_ACTION = GeneratedLinkRendererIdentity("settings-action", "link.navigation-entry")
    val DEV_HOST = GeneratedLinkRendererIdentity("dev-host", "link.dev-host-entry")
    val DEV_PREVIEW = GeneratedLinkRendererIdentity("dev-preview", "link.dev-preview")
}

data class GeneratedPageHostRenderInputs(
    val activePage: LinkRoute,
)

data class GeneratedTargetRenderInputs(
    val model: LinkTargetPresentation,
    val targetState: GeneratedLinkTargetKindPresentation,
    val session: LinkSessionPresentation,
    val connectionState: GeneratedLinkConnectionStatePresentation,
    val recovery: LinkRecoveryPresentation,
    val recoveryState: GeneratedLinkRecoveryPhasePresentation,
)

data class GeneratedTalkRenderInputs(
    val model: LinkCapturePresentation,
    val captureState: GeneratedLinkCapturePhasePresentation,
)

data class GeneratedLatestRenderInputs(
    val model: LinkConversationPresentation,
    val deliveryState: GeneratedLinkDeliveryPhasePresentation,
    val replyState: GeneratedLinkReplyPhasePresentation,
    val playback: LinkPlaybackPresentation,
    val playbackState: GeneratedLinkPlaybackPhasePresentation,
)

data class GeneratedComposerRenderInputs(
    val model: LinkConversationPresentation,
    val deliveryState: GeneratedLinkDeliveryPhasePresentation,
    val replyState: GeneratedLinkReplyPhasePresentation,
    val target: LinkTargetPresentation,
    val targetState: GeneratedLinkTargetKindPresentation,
)

data class GeneratedActivePlaybackRenderInputs(
    val model: LinkPlaybackPresentation,
    val playbackState: GeneratedLinkPlaybackPhasePresentation,
)

data class GeneratedConnectionRenderInputs(
    val model: LinkSessionPresentation,
    val connectionState: GeneratedLinkConnectionStatePresentation,
)

data class GeneratedPublicLinkRenderInputs(
    val model: LinkSessionPresentation,
    val connectionState: GeneratedLinkConnectionStatePresentation,
)

data class GeneratedPreferencesRenderInputs(
    val model: LinkPreferencesPresentation,
)

data class GeneratedLocalHistoryRenderInputs(
    val model: LinkHistoryPresentation,
)

data class GeneratedUpdatesRenderInputs(
    val model: LinkUpdatePresentation,
    val updateState: GeneratedLinkUpdatePhasePresentation,
)

data class GeneratedRecoveryRenderInputs(
    val model: LinkRecoveryPresentation,
    val recoveryState: GeneratedLinkRecoveryPhasePresentation,
)

data object GeneratedSettingsActionRenderInputs

data object GeneratedDevHostRenderInputs

data object GeneratedDevPreviewRenderInputs

data object GeneratedPageHostRenderEmitter

fun interface GeneratedTargetRenderEmitter {
    fun select(event: LinkTargetSelectEvent)
}

fun interface GeneratedTalkRenderEmitter {
    fun command(event: LinkCaptureCommandEvent)
}

interface GeneratedLatestRenderEmitter {
    fun playbackCommand(event: LinkPlaybackCommandEvent)
    fun openAttachment(event: LinkOpenAttachmentEvent)
}

interface GeneratedComposerRenderEmitter {
    fun compose(event: LinkComposeEvent)
    fun edit(event: LinkComposerEditEvent)
}

fun interface GeneratedActivePlaybackRenderEmitter {
    fun command(event: LinkPlaybackCommandEvent)
}

data object GeneratedConnectionRenderEmitter

fun interface GeneratedPublicLinkRenderEmitter {
    fun command(event: LinkPublicLinkCommandEvent)
}

fun interface GeneratedPreferencesRenderEmitter {
    fun toggle(event: LinkPreferenceToggleEvent)
}

data object GeneratedLocalHistoryRenderEmitter

fun interface GeneratedUpdatesRenderEmitter {
    fun command(event: LinkUpdateCommandEvent)
}

data object GeneratedRecoveryRenderEmitter

fun interface GeneratedSettingsActionRenderEmitter {
    fun open(event: LinkRouteOpenEvent)
}

fun interface GeneratedDevHostRenderEmitter {
    fun open(event: LinkRouteOpenEvent)
}

data object GeneratedDevPreviewRenderEmitter
