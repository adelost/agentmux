package io.agentmux.audioinbox.wear

import io.agentmux.linkui.LinkCaptureControl
import io.agentmux.linkui.WearConnectionRenderer
import io.agentmux.linkui.WearLatestRenderer
import io.agentmux.linkui.WearRecoveryRenderer
import io.agentmux.linkui.WearTargetRenderer
import io.agentmux.linkui.WearUpdatesRenderer
import io.agentmux.linkui.product.LinkNativeComponentRendererRegistration
import io.agentmux.linkui.product.LinkProductGraph
import io.agentmux.linkui.product.nativeRendererRegistration
import io.agentmux.linkui.product.generated.*

/** Actual Wear renderer registrations; every endpoint is executable. */
internal fun LinkProductGraph.nativeWearRendererRegistrations(): List<LinkNativeComponentRendererRegistration> =
    listOf(
        nativeRendererRegistration(
            GeneratedLinkComponentId.PAGE_HOST,
            listOf(
                GeneratedLinkRendererScopeId.PAGE_HOST_WEAR_FULL_UI_HOME_ROUND_PAGE_HOST,
                GeneratedLinkRendererScopeId.PAGE_HOST_WEAR_FULL_UI_SETTINGS_ROUND_PAGE_HOST,
            ), listOf(GeneratedLinkRendererInputId.PAGE_HOST_ACTIVEPAGE), emptyList(),
        ) { _, _ -> Unit },
        nativeRendererRegistration(
            GeneratedLinkComponentId.TARGET,
            listOf(GeneratedLinkRendererScopeId.TARGET_WEAR_FULL_UI_HOME_ROUND_TARGET),
            listOf(
                GeneratedLinkRendererInputId.TARGET_MODEL,
                GeneratedLinkRendererInputId.TARGET_TARGETSTATE,
                GeneratedLinkRendererInputId.TARGET_SESSION,
                GeneratedLinkRendererInputId.TARGET_CONNECTIONSTATE,
                GeneratedLinkRendererInputId.TARGET_RECOVERY,
                GeneratedLinkRendererInputId.TARGET_RECOVERYSTATE,
            ), listOf(GeneratedLinkRendererEventId.TARGET_SELECT),
        ) { inputs, emitter -> WearTargetRenderer(
            inputs as GeneratedTargetRenderInputs, emitter as GeneratedTargetRenderEmitter,
        ) },
        nativeRendererRegistration(
            GeneratedLinkComponentId.TALK,
            listOf(GeneratedLinkRendererScopeId.TALK_WEAR_FULL_UI_HOME_ROUND_TALK),
            listOf(GeneratedLinkRendererInputId.TALK_MODEL, GeneratedLinkRendererInputId.TALK_CAPTURESTATE),
            listOf(GeneratedLinkRendererEventId.TALK_COMMAND),
        ) { inputs, emitter -> LinkCaptureControl(
            inputs as GeneratedTalkRenderInputs, emitter as GeneratedTalkRenderEmitter,
        ) },
        nativeRendererRegistration(
            GeneratedLinkComponentId.LATEST,
            listOf(GeneratedLinkRendererScopeId.LATEST_WEAR_FULL_UI_HOME_ROUND_LATEST),
            listOf(
                GeneratedLinkRendererInputId.LATEST_MODEL,
                GeneratedLinkRendererInputId.LATEST_DELIVERYSTATE,
                GeneratedLinkRendererInputId.LATEST_REPLYSTATE,
                GeneratedLinkRendererInputId.LATEST_PLAYBACK,
                GeneratedLinkRendererInputId.LATEST_PLAYBACKSTATE,
            ), listOf(
                GeneratedLinkRendererEventId.LATEST_PLAYBACKCOMMAND,
                GeneratedLinkRendererEventId.LATEST_OPENATTACHMENT,
            ),
        ) { inputs, emitter -> WearLatestRenderer(
            inputs as GeneratedLatestRenderInputs, emitter as GeneratedLatestRenderEmitter,
        ) },
        nativeRendererRegistration(
            GeneratedLinkComponentId.CONNECTION,
            listOf(GeneratedLinkRendererScopeId.CONNECTION_WEAR_FULL_UI_SETTINGS_ROUND_CONNECTION),
            listOf(GeneratedLinkRendererInputId.CONNECTION_MODEL, GeneratedLinkRendererInputId.CONNECTION_CONNECTIONSTATE),
            emptyList(),
        ) { inputs, _ -> WearConnectionRenderer(
            inputs as GeneratedConnectionRenderInputs, GeneratedConnectionRenderEmitter,
        ) },
        nativeRendererRegistration(
            GeneratedLinkComponentId.UPDATES,
            listOf(GeneratedLinkRendererScopeId.UPDATES_WEAR_FULL_UI_SETTINGS_ROUND_UPDATES),
            listOf(GeneratedLinkRendererInputId.UPDATES_MODEL, GeneratedLinkRendererInputId.UPDATES_UPDATESTATE),
            listOf(GeneratedLinkRendererEventId.UPDATES_COMMAND),
        ) { inputs, emitter -> WearUpdatesRenderer(
            inputs as GeneratedUpdatesRenderInputs, emitter as GeneratedUpdatesRenderEmitter,
        ) },
        nativeRendererRegistration(
            GeneratedLinkComponentId.RECOVERY,
            listOf(GeneratedLinkRendererScopeId.RECOVERY_WEAR_FULL_UI_SETTINGS_ROUND_RECOVERY),
            listOf(GeneratedLinkRendererInputId.RECOVERY_MODEL, GeneratedLinkRendererInputId.RECOVERY_RECOVERYSTATE),
            emptyList(),
        ) { inputs, _ -> WearRecoveryRenderer(
            inputs as GeneratedRecoveryRenderInputs, GeneratedRecoveryRenderEmitter,
        ) },
        nativeRendererRegistration(
            GeneratedLinkComponentId.SETTINGS_ACTION,
            listOf(GeneratedLinkRendererScopeId.SETTINGS_ACTION_WEAR_FULL_UI_HOME_ROUND_SETTINGS_ACTION),
            emptyList(), listOf(GeneratedLinkRendererEventId.SETTINGS_ACTION_OPEN),
        ) { _, _ -> Unit },
    )
