package io.agentmux.audioinbox

import io.agentmux.linkui.LinkCaptureControl
import io.agentmux.linkui.product.LinkNativeComponentRendererRegistration
import io.agentmux.linkui.product.LinkProductGraph
import io.agentmux.linkui.product.nativeRendererRegistration
import io.agentmux.linkui.product.generated.*

/** Actual Phone renderer registrations; every endpoint is executable. */
internal fun LinkProductGraph.nativePhoneRendererRegistrations(): List<LinkNativeComponentRendererRegistration> =
    listOf(
        nativeRendererRegistration(
            GeneratedLinkComponentId.PAGE_HOST,
            listOf(
                GeneratedLinkRendererScopeId.PAGE_HOST_PHONE_FULL_UI_HOME_ROUND_PAGE_HOST,
                GeneratedLinkRendererScopeId.PAGE_HOST_PHONE_FULL_UI_HOME_COMPACT_PAGE_HOST,
                GeneratedLinkRendererScopeId.PAGE_HOST_PHONE_FULL_UI_HOME_WIDE_PAGE_HOST,
                GeneratedLinkRendererScopeId.PAGE_HOST_PHONE_FULL_UI_SETTINGS_ROUND_PAGE_HOST,
                GeneratedLinkRendererScopeId.PAGE_HOST_PHONE_FULL_UI_SETTINGS_COMPACT_PAGE_HOST,
                GeneratedLinkRendererScopeId.PAGE_HOST_PHONE_FULL_UI_SETTINGS_WIDE_PAGE_HOST,
                GeneratedLinkRendererScopeId.PAGE_HOST_PHONE_FULL_UI_DEV_HOST_ROUND_PAGE_HOST,
                GeneratedLinkRendererScopeId.PAGE_HOST_PHONE_FULL_UI_DEV_HOST_COMPACT_PAGE_HOST,
                GeneratedLinkRendererScopeId.PAGE_HOST_PHONE_FULL_UI_DEV_HOST_WIDE_PAGE_HOST,
            ),
            listOf(GeneratedLinkRendererInputId.PAGE_HOST_ACTIVEPAGE), emptyList(),
        ) { _, _ -> Unit },
        nativeRendererRegistration(
            GeneratedLinkComponentId.TARGET,
            listOf(
                GeneratedLinkRendererScopeId.TARGET_PHONE_FULL_UI_HOME_ROUND_TARGET,
                GeneratedLinkRendererScopeId.TARGET_PHONE_FULL_UI_HOME_COMPACT_TARGET,
                GeneratedLinkRendererScopeId.TARGET_PHONE_FULL_UI_HOME_WIDE_TARGET,
            ),
            listOf(
                GeneratedLinkRendererInputId.TARGET_MODEL,
                GeneratedLinkRendererInputId.TARGET_TARGETSTATE,
                GeneratedLinkRendererInputId.TARGET_SESSION,
                GeneratedLinkRendererInputId.TARGET_CONNECTIONSTATE,
                GeneratedLinkRendererInputId.TARGET_RECOVERY,
                GeneratedLinkRendererInputId.TARGET_RECOVERYSTATE,
            ),
            listOf(GeneratedLinkRendererEventId.TARGET_SELECT),
        ) { inputs, emitter ->
            PhoneTargetRenderer(inputs as GeneratedTargetRenderInputs, emitter as GeneratedTargetRenderEmitter)
        },
        nativeRendererRegistration(
            GeneratedLinkComponentId.TALK,
            listOf(
                GeneratedLinkRendererScopeId.TALK_PHONE_FULL_UI_HOME_ROUND_TALK,
                GeneratedLinkRendererScopeId.TALK_PHONE_FULL_UI_HOME_COMPACT_TALK,
                GeneratedLinkRendererScopeId.TALK_PHONE_FULL_UI_HOME_WIDE_TALK,
            ),
            listOf(GeneratedLinkRendererInputId.TALK_MODEL, GeneratedLinkRendererInputId.TALK_CAPTURESTATE),
            listOf(GeneratedLinkRendererEventId.TALK_COMMAND),
        ) { inputs, emitter ->
            LinkCaptureControl(inputs as GeneratedTalkRenderInputs, emitter as GeneratedTalkRenderEmitter)
        },
        nativeRendererRegistration(
            GeneratedLinkComponentId.LATEST,
            listOf(
                GeneratedLinkRendererScopeId.LATEST_PHONE_FULL_UI_HOME_ROUND_LATEST,
                GeneratedLinkRendererScopeId.LATEST_PHONE_FULL_UI_HOME_COMPACT_LATEST,
                GeneratedLinkRendererScopeId.LATEST_PHONE_FULL_UI_HOME_WIDE_LATEST,
            ),
            listOf(
                GeneratedLinkRendererInputId.LATEST_MODEL,
                GeneratedLinkRendererInputId.LATEST_DELIVERYSTATE,
                GeneratedLinkRendererInputId.LATEST_REPLYSTATE,
                GeneratedLinkRendererInputId.LATEST_PLAYBACK,
                GeneratedLinkRendererInputId.LATEST_PLAYBACKSTATE,
            ),
            listOf(
                GeneratedLinkRendererEventId.LATEST_PLAYBACKCOMMAND,
                GeneratedLinkRendererEventId.LATEST_OPENATTACHMENT,
            ),
        ) { inputs, emitter ->
            PhoneLatestRenderer(inputs as GeneratedLatestRenderInputs, emitter as GeneratedLatestRenderEmitter)
        },
        nativeRendererRegistration(
            GeneratedLinkComponentId.COMPOSER,
            listOf(
                GeneratedLinkRendererScopeId.COMPOSER_PHONE_FULL_UI_HOME_COMPACT_COMPOSER,
                GeneratedLinkRendererScopeId.COMPOSER_PHONE_FULL_UI_HOME_WIDE_COMPOSER,
            ),
            listOf(
                GeneratedLinkRendererInputId.COMPOSER_MODEL,
                GeneratedLinkRendererInputId.COMPOSER_DELIVERYSTATE,
                GeneratedLinkRendererInputId.COMPOSER_REPLYSTATE,
                GeneratedLinkRendererInputId.COMPOSER_TARGET,
                GeneratedLinkRendererInputId.COMPOSER_TARGETSTATE,
            ),
            listOf(GeneratedLinkRendererEventId.COMPOSER_COMPOSE, GeneratedLinkRendererEventId.COMPOSER_EDIT),
        ) { inputs, emitter ->
            PhoneComposerRenderer(inputs as GeneratedComposerRenderInputs, emitter as GeneratedComposerRenderEmitter)
        },
        nativeRendererRegistration(
            GeneratedLinkComponentId.ACTIVE_PLAYBACK,
            listOf(
                GeneratedLinkRendererScopeId.ACTIVE_PLAYBACK_PHONE_FULL_UI_SETTINGS_COMPACT_ACTIVE_PLAYBACK,
                GeneratedLinkRendererScopeId.ACTIVE_PLAYBACK_PHONE_FULL_UI_SETTINGS_WIDE_ACTIVE_PLAYBACK,
            ),
            listOf(
                GeneratedLinkRendererInputId.ACTIVE_PLAYBACK_MODEL,
                GeneratedLinkRendererInputId.ACTIVE_PLAYBACK_PLAYBACKSTATE,
            ),
            listOf(GeneratedLinkRendererEventId.ACTIVE_PLAYBACK_COMMAND),
        ) { inputs, emitter -> PhoneActivePlaybackRenderer(
            inputs as GeneratedActivePlaybackRenderInputs, emitter as GeneratedActivePlaybackRenderEmitter,
        ) },
        nativeRendererRegistration(
            GeneratedLinkComponentId.CONNECTION,
            listOf(
                GeneratedLinkRendererScopeId.CONNECTION_PHONE_FULL_UI_SETTINGS_ROUND_CONNECTION,
                GeneratedLinkRendererScopeId.CONNECTION_PHONE_FULL_UI_SETTINGS_COMPACT_CONNECTION,
                GeneratedLinkRendererScopeId.CONNECTION_PHONE_FULL_UI_SETTINGS_WIDE_CONNECTION,
            ),
            listOf(
                GeneratedLinkRendererInputId.CONNECTION_MODEL,
                GeneratedLinkRendererInputId.CONNECTION_CONNECTIONSTATE,
            ), emptyList(),
        ) { inputs, _ -> PhoneConnectionRenderer(inputs as GeneratedConnectionRenderInputs, GeneratedConnectionRenderEmitter) },
        nativeRendererRegistration(
            GeneratedLinkComponentId.PUBLIC_LINK,
            listOf(
                GeneratedLinkRendererScopeId.PUBLIC_LINK_PHONE_FULL_UI_SETTINGS_COMPACT_PUBLIC_LINK,
                GeneratedLinkRendererScopeId.PUBLIC_LINK_PHONE_FULL_UI_SETTINGS_WIDE_PUBLIC_LINK,
            ),
            listOf(GeneratedLinkRendererInputId.PUBLIC_LINK_MODEL, GeneratedLinkRendererInputId.PUBLIC_LINK_CONNECTIONSTATE),
            listOf(GeneratedLinkRendererEventId.PUBLIC_LINK_COMMAND),
        ) { inputs, emitter -> PhonePublicLinkRenderer(
            inputs as GeneratedPublicLinkRenderInputs, emitter as GeneratedPublicLinkRenderEmitter,
        ) },
        nativeRendererRegistration(
            GeneratedLinkComponentId.PREFERENCES,
            listOf(
                GeneratedLinkRendererScopeId.PREFERENCES_PHONE_FULL_UI_SETTINGS_COMPACT_PREFERENCES,
                GeneratedLinkRendererScopeId.PREFERENCES_PHONE_FULL_UI_SETTINGS_WIDE_PREFERENCES,
            ), listOf(GeneratedLinkRendererInputId.PREFERENCES_MODEL),
            listOf(GeneratedLinkRendererEventId.PREFERENCES_TOGGLE),
        ) { inputs, emitter -> PhonePreferencesRenderer(
            inputs as GeneratedPreferencesRenderInputs, emitter as GeneratedPreferencesRenderEmitter,
        ) },
        nativeRendererRegistration(
            GeneratedLinkComponentId.LOCAL_HISTORY,
            listOf(
                GeneratedLinkRendererScopeId.LOCAL_HISTORY_PHONE_FULL_UI_SETTINGS_COMPACT_LOCAL_HISTORY,
                GeneratedLinkRendererScopeId.LOCAL_HISTORY_PHONE_FULL_UI_SETTINGS_WIDE_LOCAL_HISTORY,
            ), listOf(GeneratedLinkRendererInputId.LOCAL_HISTORY_MODEL), emptyList(),
        ) { inputs, _ -> PhoneLocalHistoryRenderer(inputs as GeneratedLocalHistoryRenderInputs, GeneratedLocalHistoryRenderEmitter) },
        nativeRendererRegistration(
            GeneratedLinkComponentId.UPDATES,
            listOf(
                GeneratedLinkRendererScopeId.UPDATES_PHONE_FULL_UI_SETTINGS_ROUND_UPDATES,
                GeneratedLinkRendererScopeId.UPDATES_PHONE_FULL_UI_SETTINGS_COMPACT_UPDATES,
                GeneratedLinkRendererScopeId.UPDATES_PHONE_FULL_UI_SETTINGS_WIDE_UPDATES,
            ), listOf(GeneratedLinkRendererInputId.UPDATES_MODEL, GeneratedLinkRendererInputId.UPDATES_UPDATESTATE),
            listOf(GeneratedLinkRendererEventId.UPDATES_COMMAND),
        ) { inputs, emitter -> PhoneUpdatesRenderer(
            inputs as GeneratedUpdatesRenderInputs, emitter as GeneratedUpdatesRenderEmitter,
        ) },
        nativeRendererRegistration(
            GeneratedLinkComponentId.RECOVERY,
            listOf(
                GeneratedLinkRendererScopeId.RECOVERY_PHONE_FULL_UI_SETTINGS_ROUND_RECOVERY,
                GeneratedLinkRendererScopeId.RECOVERY_PHONE_FULL_UI_SETTINGS_COMPACT_RECOVERY,
                GeneratedLinkRendererScopeId.RECOVERY_PHONE_FULL_UI_SETTINGS_WIDE_RECOVERY,
            ), listOf(GeneratedLinkRendererInputId.RECOVERY_MODEL, GeneratedLinkRendererInputId.RECOVERY_RECOVERYSTATE),
            emptyList(),
        ) { inputs, _ -> PhoneRecoveryRenderer(inputs as GeneratedRecoveryRenderInputs, GeneratedRecoveryRenderEmitter) },
        nativeRendererRegistration(
            GeneratedLinkComponentId.SETTINGS_ACTION,
            listOf(
                GeneratedLinkRendererScopeId.SETTINGS_ACTION_PHONE_FULL_UI_HOME_ROUND_SETTINGS_ACTION,
                GeneratedLinkRendererScopeId.SETTINGS_ACTION_PHONE_FULL_UI_HOME_COMPACT_SETTINGS_ACTION,
                GeneratedLinkRendererScopeId.SETTINGS_ACTION_PHONE_FULL_UI_HOME_WIDE_SETTINGS_ACTION,
            ), emptyList(), listOf(GeneratedLinkRendererEventId.SETTINGS_ACTION_OPEN),
        ) { _, _ -> Unit },
        nativeRendererRegistration(
            GeneratedLinkComponentId.DEV_HOST,
            listOf(
                GeneratedLinkRendererScopeId.DEV_HOST_PHONE_FULL_UI_SETTINGS_ROUND_DEV_HOST,
                GeneratedLinkRendererScopeId.DEV_HOST_PHONE_FULL_UI_SETTINGS_COMPACT_DEV_HOST,
                GeneratedLinkRendererScopeId.DEV_HOST_PHONE_FULL_UI_SETTINGS_WIDE_DEV_HOST,
            ), emptyList(), listOf(GeneratedLinkRendererEventId.DEV_HOST_OPEN),
        ) { _, _ -> Unit },
        nativeRendererRegistration(
            GeneratedLinkComponentId.DEV_PREVIEW,
            listOf(
                GeneratedLinkRendererScopeId.DEV_PREVIEW_PHONE_FULL_UI_DEV_HOST_ROUND_DEV_PREVIEW,
                GeneratedLinkRendererScopeId.DEV_PREVIEW_PHONE_FULL_UI_DEV_HOST_COMPACT_DEV_PREVIEW,
                GeneratedLinkRendererScopeId.DEV_PREVIEW_PHONE_FULL_UI_DEV_HOST_WIDE_DEV_PREVIEW,
            ), listOf(GeneratedLinkRendererInputId.DEV_PREVIEW_MODEL),
            listOf(GeneratedLinkRendererEventId.DEV_PREVIEW_BACK),
        ) { inputs, emitter -> LinkDevHostScreen(
            inputs as GeneratedDevPreviewRenderInputs, emitter as GeneratedDevPreviewRenderEmitter,
        ) },
    )
