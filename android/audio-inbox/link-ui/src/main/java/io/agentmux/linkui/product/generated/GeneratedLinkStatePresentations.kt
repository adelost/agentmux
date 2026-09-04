// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM ProductConfig.stateAuthorities
// Product declarations SHA-256: 75f86032a2c5f67a6d940a6fa85406fdc56bdb512b2411b78397da135b7a4cf1
package io.agentmux.linkui.product.generated

import io.agentmux.linkui.product.ProductComponentInput
import io.agentmux.linkui.product.ProductDataInput
import io.agentmux.linkui.product.ProductOutputPort

internal enum class GeneratedLinkCapturePhaseValue(val wireId: String) {
    IDLE("idle"),
    LISTENING("listening"),
    FINALIZING("finalizing"),
    FAILED("failed"),
}
internal enum class GeneratedLinkDeliveryPhaseValue(val wireId: String) {
    NONE("none"),
    SENDING("sending"),
    QUEUED("queued"),
    FAILED("failed"),
}
internal enum class GeneratedLinkReplyPhaseValue(val wireId: String) {
    NONE("none"),
    THINKING("thinking"),
    READY("ready"),
    FAILED("failed"),
}
internal enum class GeneratedLinkPlaybackPhaseValue(val wireId: String) {
    IDLE("idle"),
    QUEUED("queued"),
    PLAYING("playing"),
    PAUSED("paused"),
    STOPPED("stopped"),
    PLAYED("played"),
    SKIPPED("skipped"),
    FAILED("failed"),
}
internal enum class GeneratedLinkTargetKindValue(val wireId: String) {
    NONE("none"),
    AGENT("agent"),
    WINDOWS("windows"),
    PUBLIC("public"),
}
internal enum class GeneratedLinkConnectionStateValue(val wireId: String) {
    OFF("off"),
    CONNECTING("connecting"),
    CONNECTED("connected"),
    DISCONNECTED("disconnected"),
    CONFIGURATION_REQUIRED("configuration-required"),
}
internal enum class GeneratedLinkUpdatePhaseValue(val wireId: String) {
    IDLE("idle"),
    CHECKING("checking"),
    UP_TO_DATE("up-to-date"),
    UNAVAILABLE("unavailable"),
    AVAILABLE("available"),
    DOWNLOADING("downloading"),
    READY_TO_INSTALL("ready-to-install"),
    INSTALLING("installing"),
    INSTALL_FAILED("install-failed"),
    FAILED("failed"),
}
internal enum class GeneratedLinkRecoveryPhaseValue(val wireId: String) {
    CLEAN("clean"),
    QUARANTINED("quarantined"),
}
internal data class GeneratedCapturePhasePresentation(
    val phase: GeneratedLinkCapturePhaseValue,
)

internal object GeneratedCapturePhaseAuthority {
    fun <T : Any> inputPort(): ProductDataInput<T> = object : ProductDataInput<T>(
        GeneratedLinkNativeLegoCatalog.PortIds.CAPTURE_PHASE_PRESENTATION_ADAPTER_STATE,
    ) {}
    val outputPort: ProductOutputPort<GeneratedCapturePhasePresentation> = object : ProductOutputPort<GeneratedCapturePhasePresentation>(
        GeneratedLinkNativeLegoCatalog.PortIds.CAPTURE_PHASE_PRESENTATION_ADAPTER_PRESENTATION,
    ) {}
    val componentInputs: List<ProductComponentInput<GeneratedCapturePhasePresentation>> = listOf(
        object : ProductComponentInput<GeneratedCapturePhasePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.CAPTURE_TALK_CAPTURESTATE,
        ) {},
    )
    private val cases: Map<String, GeneratedCapturePhasePresentation> = mapOf(
        "idle" to GeneratedCapturePhasePresentation(phase = GeneratedLinkCapturePhaseValue.IDLE),
        "listening" to GeneratedCapturePhasePresentation(phase = GeneratedLinkCapturePhaseValue.LISTENING),
        "finalizing" to GeneratedCapturePhasePresentation(phase = GeneratedLinkCapturePhaseValue.FINALIZING),
        "failed" to GeneratedCapturePhasePresentation(phase = GeneratedLinkCapturePhaseValue.FAILED),
    )

    fun require(stateId: String): GeneratedCapturePhasePresentation = requireNotNull(cases[stateId]) {
        "Unknown capture.phase state '$stateId'"
    }
}

internal data class GeneratedConversationDeliveryPhasePresentation(
    val phase: GeneratedLinkDeliveryPhaseValue,
)

internal object GeneratedConversationDeliveryPhaseAuthority {
    fun <T : Any> inputPort(): ProductDataInput<T> = object : ProductDataInput<T>(
        GeneratedLinkNativeLegoCatalog.PortIds.CONVERSATION_DELIVERY_PHASE_PRESENTATION_ADAPTER_STATE,
    ) {}
    val outputPort: ProductOutputPort<GeneratedConversationDeliveryPhasePresentation> = object : ProductOutputPort<GeneratedConversationDeliveryPhasePresentation>(
        GeneratedLinkNativeLegoCatalog.PortIds.CONVERSATION_DELIVERY_PHASE_PRESENTATION_ADAPTER_PRESENTATION,
    ) {}
    val componentInputs: List<ProductComponentInput<GeneratedConversationDeliveryPhasePresentation>> = listOf(
        object : ProductComponentInput<GeneratedConversationDeliveryPhasePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.CONVERSATION_LATEST_DELIVERYSTATE,
        ) {},
        object : ProductComponentInput<GeneratedConversationDeliveryPhasePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.CONVERSATION_COMPOSER_DELIVERYSTATE,
        ) {},
    )
    private val cases: Map<String, GeneratedConversationDeliveryPhasePresentation> = mapOf(
        "none" to GeneratedConversationDeliveryPhasePresentation(phase = GeneratedLinkDeliveryPhaseValue.NONE),
        "sending" to GeneratedConversationDeliveryPhasePresentation(phase = GeneratedLinkDeliveryPhaseValue.SENDING),
        "queued" to GeneratedConversationDeliveryPhasePresentation(phase = GeneratedLinkDeliveryPhaseValue.QUEUED),
        "failed" to GeneratedConversationDeliveryPhasePresentation(phase = GeneratedLinkDeliveryPhaseValue.FAILED),
    )

    fun require(stateId: String): GeneratedConversationDeliveryPhasePresentation = requireNotNull(cases[stateId]) {
        "Unknown conversation.delivery-phase state '$stateId'"
    }
}

internal data class GeneratedConversationReplyPhasePresentation(
    val phase: GeneratedLinkReplyPhaseValue,
)

internal object GeneratedConversationReplyPhaseAuthority {
    fun <T : Any> inputPort(): ProductDataInput<T> = object : ProductDataInput<T>(
        GeneratedLinkNativeLegoCatalog.PortIds.CONVERSATION_REPLY_PHASE_PRESENTATION_ADAPTER_STATE,
    ) {}
    val outputPort: ProductOutputPort<GeneratedConversationReplyPhasePresentation> = object : ProductOutputPort<GeneratedConversationReplyPhasePresentation>(
        GeneratedLinkNativeLegoCatalog.PortIds.CONVERSATION_REPLY_PHASE_PRESENTATION_ADAPTER_PRESENTATION,
    ) {}
    val componentInputs: List<ProductComponentInput<GeneratedConversationReplyPhasePresentation>> = listOf(
        object : ProductComponentInput<GeneratedConversationReplyPhasePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.CONVERSATION_LATEST_REPLYSTATE,
        ) {},
        object : ProductComponentInput<GeneratedConversationReplyPhasePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.CONVERSATION_COMPOSER_REPLYSTATE,
        ) {},
    )
    private val cases: Map<String, GeneratedConversationReplyPhasePresentation> = mapOf(
        "none" to GeneratedConversationReplyPhasePresentation(phase = GeneratedLinkReplyPhaseValue.NONE),
        "thinking" to GeneratedConversationReplyPhasePresentation(phase = GeneratedLinkReplyPhaseValue.THINKING),
        "ready" to GeneratedConversationReplyPhasePresentation(phase = GeneratedLinkReplyPhaseValue.READY),
        "failed" to GeneratedConversationReplyPhasePresentation(phase = GeneratedLinkReplyPhaseValue.FAILED),
    )

    fun require(stateId: String): GeneratedConversationReplyPhasePresentation = requireNotNull(cases[stateId]) {
        "Unknown conversation.reply-phase state '$stateId'"
    }
}

internal data class GeneratedPlaybackPhasePresentation(
    val phase: GeneratedLinkPlaybackPhaseValue,
)

internal object GeneratedPlaybackPhaseAuthority {
    fun <T : Any> inputPort(): ProductDataInput<T> = object : ProductDataInput<T>(
        GeneratedLinkNativeLegoCatalog.PortIds.PLAYBACK_PHASE_PRESENTATION_ADAPTER_STATE,
    ) {}
    val outputPort: ProductOutputPort<GeneratedPlaybackPhasePresentation> = object : ProductOutputPort<GeneratedPlaybackPhasePresentation>(
        GeneratedLinkNativeLegoCatalog.PortIds.PLAYBACK_PHASE_PRESENTATION_ADAPTER_PRESENTATION,
    ) {}
    val componentInputs: List<ProductComponentInput<GeneratedPlaybackPhasePresentation>> = listOf(
        object : ProductComponentInput<GeneratedPlaybackPhasePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.PLAYBACK_CONTROLS_PLAYBACKSTATE,
        ) {},
    )
    private val cases: Map<String, GeneratedPlaybackPhasePresentation> = mapOf(
        "idle" to GeneratedPlaybackPhasePresentation(phase = GeneratedLinkPlaybackPhaseValue.IDLE),
        "queued" to GeneratedPlaybackPhasePresentation(phase = GeneratedLinkPlaybackPhaseValue.QUEUED),
        "playing" to GeneratedPlaybackPhasePresentation(phase = GeneratedLinkPlaybackPhaseValue.PLAYING),
        "paused" to GeneratedPlaybackPhasePresentation(phase = GeneratedLinkPlaybackPhaseValue.PAUSED),
        "stopped" to GeneratedPlaybackPhasePresentation(phase = GeneratedLinkPlaybackPhaseValue.STOPPED),
        "played" to GeneratedPlaybackPhasePresentation(phase = GeneratedLinkPlaybackPhaseValue.PLAYED),
        "skipped" to GeneratedPlaybackPhasePresentation(phase = GeneratedLinkPlaybackPhaseValue.SKIPPED),
        "failed" to GeneratedPlaybackPhasePresentation(phase = GeneratedLinkPlaybackPhaseValue.FAILED),
    )

    fun require(stateId: String): GeneratedPlaybackPhasePresentation = requireNotNull(cases[stateId]) {
        "Unknown playback.phase state '$stateId'"
    }
}

internal data class GeneratedTargetKindPresentation(
    val kind: GeneratedLinkTargetKindValue,
)

internal object GeneratedTargetKindAuthority {
    fun <T : Any> inputPort(): ProductDataInput<T> = object : ProductDataInput<T>(
        GeneratedLinkNativeLegoCatalog.PortIds.TARGET_KIND_PRESENTATION_ADAPTER_STATE,
    ) {}
    val outputPort: ProductOutputPort<GeneratedTargetKindPresentation> = object : ProductOutputPort<GeneratedTargetKindPresentation>(
        GeneratedLinkNativeLegoCatalog.PortIds.TARGET_KIND_PRESENTATION_ADAPTER_PRESENTATION,
    ) {}
    val componentInputs: List<ProductComponentInput<GeneratedTargetKindPresentation>> = listOf(
        object : ProductComponentInput<GeneratedTargetKindPresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.TARGET_PICKER_TARGETSTATE,
        ) {},
    )
    private val cases: Map<String, GeneratedTargetKindPresentation> = mapOf(
        "none" to GeneratedTargetKindPresentation(kind = GeneratedLinkTargetKindValue.NONE),
        "agent" to GeneratedTargetKindPresentation(kind = GeneratedLinkTargetKindValue.AGENT),
        "windows" to GeneratedTargetKindPresentation(kind = GeneratedLinkTargetKindValue.WINDOWS),
        "public" to GeneratedTargetKindPresentation(kind = GeneratedLinkTargetKindValue.PUBLIC),
    )

    fun require(stateId: String): GeneratedTargetKindPresentation = requireNotNull(cases[stateId]) {
        "Unknown target.kind state '$stateId'"
    }
}

internal data class GeneratedSessionConnectionStatePresentation(
    val connection: GeneratedLinkConnectionStateValue,
)

internal object GeneratedSessionConnectionStateAuthority {
    fun <T : Any> inputPort(): ProductDataInput<T> = object : ProductDataInput<T>(
        GeneratedLinkNativeLegoCatalog.PortIds.SESSION_CONNECTION_STATE_PRESENTATION_ADAPTER_STATE,
    ) {}
    val outputPort: ProductOutputPort<GeneratedSessionConnectionStatePresentation> = object : ProductOutputPort<GeneratedSessionConnectionStatePresentation>(
        GeneratedLinkNativeLegoCatalog.PortIds.SESSION_CONNECTION_STATE_PRESENTATION_ADAPTER_PRESENTATION,
    ) {}
    val componentInputs: List<ProductComponentInput<GeneratedSessionConnectionStatePresentation>> = listOf(
        object : ProductComponentInput<GeneratedSessionConnectionStatePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.SESSION_CONNECTION_CONNECTIONSTATE,
        ) {},
        object : ProductComponentInput<GeneratedSessionConnectionStatePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.SESSION_PUBLIC_LINK_CONNECTIONSTATE,
        ) {},
    )
    private val cases: Map<String, GeneratedSessionConnectionStatePresentation> = mapOf(
        "off" to GeneratedSessionConnectionStatePresentation(connection = GeneratedLinkConnectionStateValue.OFF),
        "connecting" to GeneratedSessionConnectionStatePresentation(connection = GeneratedLinkConnectionStateValue.CONNECTING),
        "connected" to GeneratedSessionConnectionStatePresentation(connection = GeneratedLinkConnectionStateValue.CONNECTED),
        "disconnected" to GeneratedSessionConnectionStatePresentation(connection = GeneratedLinkConnectionStateValue.DISCONNECTED),
        "configuration-required" to GeneratedSessionConnectionStatePresentation(connection = GeneratedLinkConnectionStateValue.CONFIGURATION_REQUIRED),
    )

    fun require(stateId: String): GeneratedSessionConnectionStatePresentation = requireNotNull(cases[stateId]) {
        "Unknown session.connection-state state '$stateId'"
    }
}

internal data class GeneratedUpdatesPhasePresentation(
    val phase: GeneratedLinkUpdatePhaseValue,
)

internal object GeneratedUpdatesPhaseAuthority {
    fun <T : Any> inputPort(): ProductDataInput<T> = object : ProductDataInput<T>(
        GeneratedLinkNativeLegoCatalog.PortIds.UPDATES_PHASE_PRESENTATION_ADAPTER_STATE,
    ) {}
    val outputPort: ProductOutputPort<GeneratedUpdatesPhasePresentation> = object : ProductOutputPort<GeneratedUpdatesPhasePresentation>(
        GeneratedLinkNativeLegoCatalog.PortIds.UPDATES_PHASE_PRESENTATION_ADAPTER_PRESENTATION,
    ) {}
    val componentInputs: List<ProductComponentInput<GeneratedUpdatesPhasePresentation>> = listOf(
        object : ProductComponentInput<GeneratedUpdatesPhasePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.UPDATES_PANEL_UPDATESTATE,
        ) {},
    )
    private val cases: Map<String, GeneratedUpdatesPhasePresentation> = mapOf(
        "idle" to GeneratedUpdatesPhasePresentation(phase = GeneratedLinkUpdatePhaseValue.IDLE),
        "checking" to GeneratedUpdatesPhasePresentation(phase = GeneratedLinkUpdatePhaseValue.CHECKING),
        "up-to-date" to GeneratedUpdatesPhasePresentation(phase = GeneratedLinkUpdatePhaseValue.UP_TO_DATE),
        "unavailable" to GeneratedUpdatesPhasePresentation(phase = GeneratedLinkUpdatePhaseValue.UNAVAILABLE),
        "available" to GeneratedUpdatesPhasePresentation(phase = GeneratedLinkUpdatePhaseValue.AVAILABLE),
        "downloading" to GeneratedUpdatesPhasePresentation(phase = GeneratedLinkUpdatePhaseValue.DOWNLOADING),
        "ready-to-install" to GeneratedUpdatesPhasePresentation(phase = GeneratedLinkUpdatePhaseValue.READY_TO_INSTALL),
        "installing" to GeneratedUpdatesPhasePresentation(phase = GeneratedLinkUpdatePhaseValue.INSTALLING),
        "install-failed" to GeneratedUpdatesPhasePresentation(phase = GeneratedLinkUpdatePhaseValue.INSTALL_FAILED),
        "failed" to GeneratedUpdatesPhasePresentation(phase = GeneratedLinkUpdatePhaseValue.FAILED),
    )

    fun require(stateId: String): GeneratedUpdatesPhasePresentation = requireNotNull(cases[stateId]) {
        "Unknown updates.phase state '$stateId'"
    }
}

internal data class GeneratedRecoveryPhasePresentation(
    val phase: GeneratedLinkRecoveryPhaseValue,
)

internal object GeneratedRecoveryPhaseAuthority {
    fun <T : Any> inputPort(): ProductDataInput<T> = object : ProductDataInput<T>(
        GeneratedLinkNativeLegoCatalog.PortIds.RECOVERY_PHASE_PRESENTATION_ADAPTER_STATE,
    ) {}
    val outputPort: ProductOutputPort<GeneratedRecoveryPhasePresentation> = object : ProductOutputPort<GeneratedRecoveryPhasePresentation>(
        GeneratedLinkNativeLegoCatalog.PortIds.RECOVERY_PHASE_PRESENTATION_ADAPTER_PRESENTATION,
    ) {}
    val componentInputs: List<ProductComponentInput<GeneratedRecoveryPhasePresentation>> = listOf(
        object : ProductComponentInput<GeneratedRecoveryPhasePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.RECOVERY_STATUS_RECOVERYSTATE,
        ) {},
    )
    private val cases: Map<String, GeneratedRecoveryPhasePresentation> = mapOf(
        "clean" to GeneratedRecoveryPhasePresentation(phase = GeneratedLinkRecoveryPhaseValue.CLEAN),
        "quarantined" to GeneratedRecoveryPhasePresentation(phase = GeneratedLinkRecoveryPhaseValue.QUARANTINED),
    )

    fun require(stateId: String): GeneratedRecoveryPhasePresentation = requireNotNull(cases[stateId]) {
        "Unknown recovery.phase state '$stateId'"
    }
}

