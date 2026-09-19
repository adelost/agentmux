package io.agentmux.linkui.product

import io.agentmux.linkui.product.generated.GeneratedLinkCapturedTurn
import io.agentmux.linkui.product.generated.GeneratedLinkComposeTurn
import io.agentmux.linkui.product.generated.GeneratedLinkHistoryClear
import io.agentmux.linkui.product.generated.GeneratedLinkHistoryStatus
import io.agentmux.linkui.product.generated.GeneratedLinkPreferencesStatus
import io.agentmux.linkui.product.generated.GeneratedLinkTargetSelect
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

internal object NavigationOpenWakeDebugInput :
    ProductInputPort<LinkRouteOpenEvent, Unit>(PortIds.NAVIGATION_SERVICE_OPENWAKEDEBUG)

internal object NavigationOpenWakeTryInput :
    ProductInputPort<LinkRouteOpenEvent, Unit>(PortIds.NAVIGATION_SERVICE_OPENWAKETRY)

internal object NavigationActivePageOutput :
    ProductOutputPort<LinkRoute>(PortIds.NAVIGATION_SERVICE_ACTIVEPAGE)

internal object CaptureCommandInput :
    ProductInputPort<LinkCaptureCommandEvent, Unit>(PortIds.CAPTURE_SERVICE_COMMAND)

internal object CaptureStatusOutput :
    ProductOutputPort<LinkCapturePresentation>(PortIds.CAPTURE_SERVICE_STATUS)

internal object CaptureCapturedOutput :
    ProductOutputPort<GeneratedLinkCapturedTurn>(PortIds.CAPTURE_SERVICE_CAPTURED)

internal object ConversationTurnInput :
    ProductDataInput<GeneratedLinkCapturedTurn>(PortIds.CONVERSATION_SERVICE_TURN)

internal object ConversationComposeInput :
    ProductInputPort<GeneratedLinkComposeTurn, Unit>(PortIds.CONVERSATION_SERVICE_COMPOSE)

internal object ConversationStatusOutput :
    ProductOutputPort<LinkConversationPresentation>(PortIds.CONVERSATION_SERVICE_STATUS)

internal object PlaybackCommandInput :
    ProductInputPort<LinkPlaybackCommandEvent, Unit>(PortIds.PLAYBACK_SERVICE_COMMAND)

internal object PlaybackStatusOutput :
    ProductOutputPort<LinkPlaybackPresentation>(PortIds.PLAYBACK_SERVICE_STATUS)

internal object TargetSelectInput :
    ProductInputPort<GeneratedLinkTargetSelect, Unit>(PortIds.TARGET_SERVICE_SELECT)

internal object TargetDirectoryOutput :
    ProductOutputPort<LinkTargetPresentation>(PortIds.TARGET_SERVICE_DIRECTORY)

internal object SessionStatusOutput :
    ProductOutputPort<LinkSessionPresentation>(PortIds.SESSION_SERVICE_STATUS)

internal object HistoryClearInput :
    ProductInputPort<GeneratedLinkHistoryClear, Unit>(PortIds.HISTORY_SERVICE_CLEAR)

internal object HistoryStatusOutput :
    ProductOutputPort<GeneratedLinkHistoryStatus>(PortIds.HISTORY_SERVICE_STATUS)

internal object PreferencesWakeToggleInput :
    ProductInputPort<LinkPreferenceToggleEvent, Unit>(PortIds.PREFERENCES_SERVICE_WAKETOGGLE)

internal object PreferencesToggleInput :
    ProductInputPort<LinkPreferenceToggleEvent, Unit>(PortIds.PREFERENCES_SERVICE_TOGGLE)

internal object PreferencesStatusOutput :
    ProductOutputPort<GeneratedLinkPreferencesStatus>(PortIds.PREFERENCES_SERVICE_STATUS)

internal object UpdatesCommandInput :
    ProductInputPort<LinkUpdateCommandEvent, Unit>(PortIds.UPDATES_SERVICE_COMMAND)

internal object UpdatesStatusOutput :
    ProductOutputPort<LinkUpdatePresentation>(PortIds.UPDATES_SERVICE_STATUS)

internal object RecoveryStatusOutput :
    ProductOutputPort<LinkRecoveryPresentation>(PortIds.RECOVERY_SERVICE_STATUS)

internal object WakeStatusOutput :
    ProductOutputPort<LinkWakePresentation>(PortIds.WAKE_SERVICE_STATUS)

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
    ProductDataInput<GeneratedLinkHistoryStatus>(PortIds.HISTORY_PRESENTATION_SOURCE)
internal object HistoryPresentationModelOutput :
    ProductOutputPort<GeneratedLinkHistoryStatus>(PortIds.HISTORY_PRESENTATION_MODEL)
internal object PreferencesPresentationSourceInput :
    ProductDataInput<GeneratedLinkPreferencesStatus>(PortIds.PREFERENCES_PRESENTATION_SOURCE)
internal object PreferencesPresentationModelOutput :
    ProductOutputPort<GeneratedLinkPreferencesStatus>(PortIds.PREFERENCES_PRESENTATION_MODEL)
internal object UpdatesPresentationSourceInput :
    ProductDataInput<LinkUpdatePresentation>(PortIds.UPDATES_PRESENTATION_SOURCE)
internal object UpdatesPresentationModelOutput :
    ProductOutputPort<LinkUpdatePresentation>(PortIds.UPDATES_PRESENTATION_MODEL)
internal object RecoveryPresentationSourceInput :
    ProductDataInput<LinkRecoveryPresentation>(PortIds.RECOVERY_PRESENTATION_SOURCE)
internal object RecoveryPresentationModelOutput :
    ProductOutputPort<LinkRecoveryPresentation>(PortIds.RECOVERY_PRESENTATION_MODEL)

internal object WakePresentationSourceInput :
    ProductDataInput<LinkWakePresentation>(PortIds.WAKE_PRESENTATION_SOURCE)
internal object WakePresentationModelOutput :
    ProductOutputPort<LinkWakePresentation>(PortIds.WAKE_PRESENTATION_MODEL)

internal object TargetModelInput :
    ProductComponentInput<LinkTargetPresentation>(PortIds.TARGET_PICKER_MODEL)

internal object TargetSelectEvent :
    ProductComponentEvent<GeneratedLinkTargetSelect, Unit>(PortIds.TARGET_PICKER_SELECT)

internal object TalkModelInput :
    ProductComponentInput<LinkCapturePresentation>(PortIds.CAPTURE_TALK_MODEL)

internal object TalkCommandEvent :
    ProductComponentEvent<LinkCaptureCommandEvent, Unit>(PortIds.CAPTURE_TALK_COMMAND)

internal object LatestModelInput :
    ProductComponentInput<LinkConversationPresentation>(PortIds.CONVERSATION_LATEST_MODEL)

internal object ComposerModelInput :
    ProductComponentInput<LinkConversationPresentation>(PortIds.CONVERSATION_COMPOSER_MODEL)

internal object ComposerComposeEvent :
    ProductComponentEvent<GeneratedLinkComposeTurn, Unit>(PortIds.CONVERSATION_COMPOSER_COMPOSE)

internal object ActivePlaybackModelInput :
    ProductComponentInput<LinkPlaybackPresentation>(PortIds.PLAYBACK_CONTROLS_MODEL)

internal object ActivePlaybackCommandEvent :
    ProductComponentEvent<LinkPlaybackCommandEvent, Unit>(PortIds.PLAYBACK_CONTROLS_COMMAND)

internal object ConnectionModelInput :
    ProductComponentInput<LinkSessionPresentation>(PortIds.SESSION_CONNECTION_MODEL)

internal object PublicLinkModelInput :
    ProductComponentInput<LinkSessionPresentation>(PortIds.SESSION_PUBLIC_LINK_MODEL)

internal object PreferencesModelInput :
    ProductComponentInput<GeneratedLinkPreferencesStatus>(PortIds.PREFERENCES_TOGGLES_MODEL)

internal object WakeToggleEvent :
    ProductComponentEvent<LinkPreferenceToggleEvent, Unit>(PortIds.WAKE_TOGGLE_TOGGLE)

internal object PreferencesToggleEvent :
    ProductComponentEvent<LinkPreferenceToggleEvent, Unit>(PortIds.PREFERENCES_TOGGLES_TOGGLE)

internal object LocalHistoryModelInput :
    ProductComponentInput<GeneratedLinkHistoryStatus>(PortIds.HISTORY_LOCAL_MODEL)

internal object LocalHistoryClearEvent :
    ProductComponentEvent<GeneratedLinkHistoryClear, Unit>(PortIds.HISTORY_LOCAL_CLEAR)

internal object UpdatesModelInput :
    ProductComponentInput<LinkUpdatePresentation>(PortIds.UPDATES_PANEL_MODEL)

internal object UpdatesCommandEvent :
    ProductComponentEvent<LinkUpdateCommandEvent, Unit>(PortIds.UPDATES_PANEL_COMMAND)

internal object RecoveryModelInput :
    ProductComponentInput<LinkRecoveryPresentation>(PortIds.RECOVERY_STATUS_MODEL)

internal object WakeToggleModelInput :
    ProductComponentInput<LinkWakePresentation>(PortIds.WAKE_TOGGLE_MODEL)

internal object WakeModelInput :
    ProductComponentInput<LinkWakePresentation>(PortIds.WAKE_STATUS_MODEL)

internal object PageHostActivePageInput :
    ProductComponentInput<LinkRoute>(PortIds.NAVIGATION_PAGE_HOST_ACTIVEPAGE)

internal object SettingsActionOpenEvent :
    ProductComponentEvent<LinkRouteOpenEvent, Unit>(PortIds.NAVIGATION_SETTINGS_ENTRY_OPEN)

internal object DevHostOpenEvent :
    ProductComponentEvent<LinkRouteOpenEvent, Unit>(PortIds.NAVIGATION_DEV_HOST_ENTRY_OPEN)

internal object WakeDebugOpenEvent :
    ProductComponentEvent<LinkRouteOpenEvent, Unit>(PortIds.NAVIGATION_WAKE_DEBUG_ENTRY_OPEN)

internal object WakeTryOpenEvent :
    ProductComponentEvent<LinkRouteOpenEvent, Unit>(PortIds.NAVIGATION_WAKE_TRY_ENTRY_OPEN)
