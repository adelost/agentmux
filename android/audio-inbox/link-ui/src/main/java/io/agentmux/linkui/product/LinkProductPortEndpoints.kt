package io.agentmux.linkui.product

import io.agentmux.linkui.product.generated.GeneratedLinkNativeLegoCatalog.PortIds

/**
 * The one typed native endpoint per generated port. Registration sites stay
 * compile-bound to the generated port ids; a dropped product port refuses to
 * compile here instead of drifting at runtime.
 */
internal object NavigationOpenSettingsInput :
    ProductInputPort<LinkRouteOpenEvent, Unit>(PortIds.NAVIGATION_SERVICE_OPENSETTINGS)

internal object NavigationOpenDevHostInput :
    ProductInputPort<LinkRouteOpenEvent, Unit>(PortIds.NAVIGATION_SERVICE_OPENDEVHOST)

internal object NavigationActivePageOutput :
    ProductOutputPort<LinkRoute>(PortIds.NAVIGATION_SERVICE_ACTIVEPAGE)

internal object CaptureCommandInput :
    ProductInputPort<LinkCaptureCommandEvent, Unit>(PortIds.CAPTURE_SERVICE_COMMAND)

internal object CaptureStatusOutput :
    ProductOutputPort<LinkCapturePresentation>(PortIds.CAPTURE_SERVICE_STATUS)

internal object CaptureCapturedOutput :
    ProductOutputPort<LinkCapturedTurn>(PortIds.CAPTURE_SERVICE_CAPTURED)

internal object ConversationTurnInput :
    ProductDataInput<LinkCapturedTurn>(PortIds.CONVERSATION_SERVICE_TURN)

internal object ConversationComposeInput :
    ProductInputPort<LinkComposeEvent, Unit>(PortIds.CONVERSATION_SERVICE_COMPOSE)

internal object ConversationStatusOutput :
    ProductOutputPort<LinkConversationPresentation>(PortIds.CONVERSATION_SERVICE_STATUS)

internal object PlaybackCommandInput :
    ProductInputPort<LinkPlaybackCommandEvent, Unit>(PortIds.PLAYBACK_SERVICE_COMMAND)

internal object PlaybackStatusOutput :
    ProductOutputPort<LinkPlaybackPresentation>(PortIds.PLAYBACK_SERVICE_STATUS)

internal object TargetSelectInput :
    ProductInputPort<LinkTargetSelectEvent, Unit>(PortIds.TARGET_SERVICE_SELECT)

internal object TargetDirectoryOutput :
    ProductOutputPort<LinkTargetPresentation>(PortIds.TARGET_SERVICE_DIRECTORY)

internal object SessionStatusOutput :
    ProductOutputPort<LinkSessionPresentation>(PortIds.SESSION_SERVICE_STATUS)

internal object HistoryStatusOutput :
    ProductOutputPort<LinkHistoryPresentation>(PortIds.HISTORY_SERVICE_STATUS)

internal object PreferencesToggleInput :
    ProductInputPort<LinkPreferenceToggleEvent, Unit>(PortIds.PREFERENCES_SERVICE_TOGGLE)

internal object PreferencesStatusOutput :
    ProductOutputPort<LinkPreferencesPresentation>(PortIds.PREFERENCES_SERVICE_STATUS)

internal object UpdatesCommandInput :
    ProductInputPort<LinkUpdateCommandEvent, Unit>(PortIds.UPDATES_SERVICE_COMMAND)

internal object UpdatesStatusOutput :
    ProductOutputPort<LinkUpdatePresentation>(PortIds.UPDATES_SERVICE_STATUS)

internal object RecoveryStatusOutput :
    ProductOutputPort<LinkRecoveryPresentation>(PortIds.RECOVERY_SERVICE_STATUS)

internal object CapturePresentationSourceInput :
    ProductDataInput<LinkCapturePresentation>(PortIds.CAPTURE_PRESENTATION_SOURCE)
internal object CapturePresentationModelOutput :
    ProductOutputPort<LinkCapturePresentation>(PortIds.CAPTURE_PRESENTATION_MODEL)
internal object ConversationPresentationSourceInput :
    ProductDataInput<LinkConversationPresentation>(PortIds.CONVERSATION_PRESENTATION_SOURCE)
internal object ConversationPresentationModelOutput :
    ProductOutputPort<LinkConversationPresentation>(PortIds.CONVERSATION_PRESENTATION_MODEL)
internal object PlaybackPresentationSourceInput :
    ProductDataInput<LinkPlaybackPresentation>(PortIds.PLAYBACK_PRESENTATION_SOURCE)
internal object PlaybackPresentationModelOutput :
    ProductOutputPort<LinkPlaybackPresentation>(PortIds.PLAYBACK_PRESENTATION_MODEL)
internal object TargetPresentationSourceInput :
    ProductDataInput<LinkTargetPresentation>(PortIds.TARGET_PRESENTATION_SOURCE)
internal object TargetPresentationModelOutput :
    ProductOutputPort<LinkTargetPresentation>(PortIds.TARGET_PRESENTATION_MODEL)
internal object SessionPresentationSourceInput :
    ProductDataInput<LinkSessionPresentation>(PortIds.SESSION_PRESENTATION_SOURCE)
internal object SessionPresentationModelOutput :
    ProductOutputPort<LinkSessionPresentation>(PortIds.SESSION_PRESENTATION_MODEL)
internal object HistoryPresentationSourceInput :
    ProductDataInput<LinkHistoryPresentation>(PortIds.HISTORY_PRESENTATION_SOURCE)
internal object HistoryPresentationModelOutput :
    ProductOutputPort<LinkHistoryPresentation>(PortIds.HISTORY_PRESENTATION_MODEL)
internal object PreferencesPresentationSourceInput :
    ProductDataInput<LinkPreferencesPresentation>(PortIds.PREFERENCES_PRESENTATION_SOURCE)
internal object PreferencesPresentationModelOutput :
    ProductOutputPort<LinkPreferencesPresentation>(PortIds.PREFERENCES_PRESENTATION_MODEL)
internal object UpdatesPresentationSourceInput :
    ProductDataInput<LinkUpdatePresentation>(PortIds.UPDATES_PRESENTATION_SOURCE)
internal object UpdatesPresentationModelOutput :
    ProductOutputPort<LinkUpdatePresentation>(PortIds.UPDATES_PRESENTATION_MODEL)
internal object RecoveryPresentationSourceInput :
    ProductDataInput<LinkRecoveryPresentation>(PortIds.RECOVERY_PRESENTATION_SOURCE)
internal object RecoveryPresentationModelOutput :
    ProductOutputPort<LinkRecoveryPresentation>(PortIds.RECOVERY_PRESENTATION_MODEL)

internal object TargetModelInput :
    ProductComponentInput<LinkTargetPresentation>(PortIds.TARGET_MODEL)

internal object TargetSelectEvent :
    ProductComponentEvent<LinkTargetSelectEvent, Unit>(PortIds.TARGET_SELECT)

internal object TalkModelInput :
    ProductComponentInput<LinkCapturePresentation>(PortIds.TALK_MODEL)

internal object TalkCommandEvent :
    ProductComponentEvent<LinkCaptureCommandEvent, Unit>(PortIds.TALK_COMMAND)

internal object LatestModelInput :
    ProductComponentInput<LinkConversationPresentation>(PortIds.LATEST_MODEL)

internal object ComposerModelInput :
    ProductComponentInput<LinkConversationPresentation>(PortIds.COMPOSER_MODEL)

internal object ComposerComposeEvent :
    ProductComponentEvent<LinkComposeEvent, Unit>(PortIds.COMPOSER_COMPOSE)

internal object ActivePlaybackModelInput :
    ProductComponentInput<LinkPlaybackPresentation>(PortIds.ACTIVE_PLAYBACK_MODEL)

internal object ActivePlaybackCommandEvent :
    ProductComponentEvent<LinkPlaybackCommandEvent, Unit>(PortIds.ACTIVE_PLAYBACK_COMMAND)

internal object ConnectionModelInput :
    ProductComponentInput<LinkSessionPresentation>(PortIds.CONNECTION_MODEL)

internal object PublicLinkModelInput :
    ProductComponentInput<LinkSessionPresentation>(PortIds.PUBLIC_LINK_MODEL)

internal object PreferencesModelInput :
    ProductComponentInput<LinkPreferencesPresentation>(PortIds.PREFERENCES_MODEL)

internal object PreferencesToggleEvent :
    ProductComponentEvent<LinkPreferenceToggleEvent, Unit>(PortIds.PREFERENCES_TOGGLE)

internal object LocalHistoryModelInput :
    ProductComponentInput<LinkHistoryPresentation>(PortIds.LOCAL_HISTORY_MODEL)

internal object UpdatesModelInput :
    ProductComponentInput<LinkUpdatePresentation>(PortIds.UPDATES_MODEL)

internal object UpdatesCommandEvent :
    ProductComponentEvent<LinkUpdateCommandEvent, Unit>(PortIds.UPDATES_COMMAND)

internal object RecoveryModelInput :
    ProductComponentInput<LinkRecoveryPresentation>(PortIds.RECOVERY_MODEL)

internal object PageHostActivePageInput :
    ProductComponentInput<LinkRoute>(PortIds.PAGE_HOST_ACTIVEPAGE)

internal object SettingsActionOpenEvent :
    ProductComponentEvent<LinkRouteOpenEvent, Unit>(PortIds.SETTINGS_ACTION_OPEN)

internal object DevHostOpenEvent :
    ProductComponentEvent<LinkRouteOpenEvent, Unit>(PortIds.DEV_HOST_OPEN)
