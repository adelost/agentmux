// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM ProductConfig.stateAuthorities
// Product declarations SHA-256: 9742e98c63220e7cd7ae686c95f5d260c85839ba23059e991a28100ca435ba27
package io.agentmux.linkui.product.generated

import io.agentmux.linkui.product.ProductComponentInput
import io.agentmux.linkui.product.ProductDataInput
import io.agentmux.linkui.product.ProductOutputPort

internal enum class GeneratedLinkRouteValue(val wireId: String) {
    HOME("home"),
    SETTINGS("settings"),
    DEV_HOST("dev-host"),
}
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
internal data class GeneratedLinkNavigationRoutePresentation(
    val route: GeneratedLinkRouteValue,
)

internal object GeneratedLinkNavigationRouteAuthority {
    fun <T : Any> inputPort(): ProductDataInput<T> = object : ProductDataInput<T>(
        GeneratedLinkNativeLegoCatalog.PortIds.LINK_NAVIGATION_ROUTE_PRESENTATION_ADAPTER_STATE,
    ) {}
    val outputPort: ProductOutputPort<GeneratedLinkNavigationRoutePresentation> = object : ProductOutputPort<GeneratedLinkNavigationRoutePresentation>(
        GeneratedLinkNativeLegoCatalog.PortIds.LINK_NAVIGATION_ROUTE_PRESENTATION_ADAPTER_PRESENTATION,
    ) {}
    val componentInputs: List<ProductComponentInput<GeneratedLinkNavigationRoutePresentation>> = listOf(
        object : ProductComponentInput<GeneratedLinkNavigationRoutePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.SETTINGS_ACTION_ROUTESTATE,
        ) {},
        object : ProductComponentInput<GeneratedLinkNavigationRoutePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.DEV_HOST_ROUTESTATE,
        ) {},
    )
    private val cases: Map<String, GeneratedLinkNavigationRoutePresentation> = mapOf(
        "home" to GeneratedLinkNavigationRoutePresentation(route = GeneratedLinkRouteValue.HOME),
        "settings" to GeneratedLinkNavigationRoutePresentation(route = GeneratedLinkRouteValue.SETTINGS),
        "dev-host" to GeneratedLinkNavigationRoutePresentation(route = GeneratedLinkRouteValue.DEV_HOST),
    )

    fun require(stateId: String): GeneratedLinkNavigationRoutePresentation = requireNotNull(cases[stateId]) {
        "Unknown link.navigation-route state '$stateId'"
    }
}

internal data class GeneratedLinkCapturePhasePresentation(
    val phase: GeneratedLinkCapturePhaseValue,
)

internal object GeneratedLinkCapturePhaseAuthority {
    fun <T : Any> inputPort(): ProductDataInput<T> = object : ProductDataInput<T>(
        GeneratedLinkNativeLegoCatalog.PortIds.LINK_CAPTURE_PHASE_PRESENTATION_ADAPTER_STATE,
    ) {}
    val outputPort: ProductOutputPort<GeneratedLinkCapturePhasePresentation> = object : ProductOutputPort<GeneratedLinkCapturePhasePresentation>(
        GeneratedLinkNativeLegoCatalog.PortIds.LINK_CAPTURE_PHASE_PRESENTATION_ADAPTER_PRESENTATION,
    ) {}
    val componentInputs: List<ProductComponentInput<GeneratedLinkCapturePhasePresentation>> = listOf(
        object : ProductComponentInput<GeneratedLinkCapturePhasePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.TALK_CAPTURESTATE,
        ) {},
    )
    private val cases: Map<String, GeneratedLinkCapturePhasePresentation> = mapOf(
        "idle" to GeneratedLinkCapturePhasePresentation(phase = GeneratedLinkCapturePhaseValue.IDLE),
        "listening" to GeneratedLinkCapturePhasePresentation(phase = GeneratedLinkCapturePhaseValue.LISTENING),
        "finalizing" to GeneratedLinkCapturePhasePresentation(phase = GeneratedLinkCapturePhaseValue.FINALIZING),
        "failed" to GeneratedLinkCapturePhasePresentation(phase = GeneratedLinkCapturePhaseValue.FAILED),
    )

    fun require(stateId: String): GeneratedLinkCapturePhasePresentation = requireNotNull(cases[stateId]) {
        "Unknown link.capture-phase state '$stateId'"
    }
}

internal data class GeneratedLinkDeliveryPhasePresentation(
    val phase: GeneratedLinkDeliveryPhaseValue,
)

internal object GeneratedLinkDeliveryPhaseAuthority {
    fun <T : Any> inputPort(): ProductDataInput<T> = object : ProductDataInput<T>(
        GeneratedLinkNativeLegoCatalog.PortIds.LINK_DELIVERY_PHASE_PRESENTATION_ADAPTER_STATE,
    ) {}
    val outputPort: ProductOutputPort<GeneratedLinkDeliveryPhasePresentation> = object : ProductOutputPort<GeneratedLinkDeliveryPhasePresentation>(
        GeneratedLinkNativeLegoCatalog.PortIds.LINK_DELIVERY_PHASE_PRESENTATION_ADAPTER_PRESENTATION,
    ) {}
    val componentInputs: List<ProductComponentInput<GeneratedLinkDeliveryPhasePresentation>> = listOf(
        object : ProductComponentInput<GeneratedLinkDeliveryPhasePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.LATEST_DELIVERYSTATE,
        ) {},
        object : ProductComponentInput<GeneratedLinkDeliveryPhasePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.COMPOSER_DELIVERYSTATE,
        ) {},
    )
    private val cases: Map<String, GeneratedLinkDeliveryPhasePresentation> = mapOf(
        "none" to GeneratedLinkDeliveryPhasePresentation(phase = GeneratedLinkDeliveryPhaseValue.NONE),
        "sending" to GeneratedLinkDeliveryPhasePresentation(phase = GeneratedLinkDeliveryPhaseValue.SENDING),
        "queued" to GeneratedLinkDeliveryPhasePresentation(phase = GeneratedLinkDeliveryPhaseValue.QUEUED),
        "failed" to GeneratedLinkDeliveryPhasePresentation(phase = GeneratedLinkDeliveryPhaseValue.FAILED),
    )

    fun require(stateId: String): GeneratedLinkDeliveryPhasePresentation = requireNotNull(cases[stateId]) {
        "Unknown link.delivery-phase state '$stateId'"
    }
}

internal data class GeneratedLinkReplyPhasePresentation(
    val phase: GeneratedLinkReplyPhaseValue,
)

internal object GeneratedLinkReplyPhaseAuthority {
    fun <T : Any> inputPort(): ProductDataInput<T> = object : ProductDataInput<T>(
        GeneratedLinkNativeLegoCatalog.PortIds.LINK_REPLY_PHASE_PRESENTATION_ADAPTER_STATE,
    ) {}
    val outputPort: ProductOutputPort<GeneratedLinkReplyPhasePresentation> = object : ProductOutputPort<GeneratedLinkReplyPhasePresentation>(
        GeneratedLinkNativeLegoCatalog.PortIds.LINK_REPLY_PHASE_PRESENTATION_ADAPTER_PRESENTATION,
    ) {}
    val componentInputs: List<ProductComponentInput<GeneratedLinkReplyPhasePresentation>> = listOf(
        object : ProductComponentInput<GeneratedLinkReplyPhasePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.LATEST_REPLYSTATE,
        ) {},
        object : ProductComponentInput<GeneratedLinkReplyPhasePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.COMPOSER_REPLYSTATE,
        ) {},
    )
    private val cases: Map<String, GeneratedLinkReplyPhasePresentation> = mapOf(
        "none" to GeneratedLinkReplyPhasePresentation(phase = GeneratedLinkReplyPhaseValue.NONE),
        "thinking" to GeneratedLinkReplyPhasePresentation(phase = GeneratedLinkReplyPhaseValue.THINKING),
        "ready" to GeneratedLinkReplyPhasePresentation(phase = GeneratedLinkReplyPhaseValue.READY),
        "failed" to GeneratedLinkReplyPhasePresentation(phase = GeneratedLinkReplyPhaseValue.FAILED),
    )

    fun require(stateId: String): GeneratedLinkReplyPhasePresentation = requireNotNull(cases[stateId]) {
        "Unknown link.reply-phase state '$stateId'"
    }
}

internal data class GeneratedLinkPlaybackPhasePresentation(
    val phase: GeneratedLinkPlaybackPhaseValue,
)

internal object GeneratedLinkPlaybackPhaseAuthority {
    fun <T : Any> inputPort(): ProductDataInput<T> = object : ProductDataInput<T>(
        GeneratedLinkNativeLegoCatalog.PortIds.LINK_PLAYBACK_PHASE_PRESENTATION_ADAPTER_STATE,
    ) {}
    val outputPort: ProductOutputPort<GeneratedLinkPlaybackPhasePresentation> = object : ProductOutputPort<GeneratedLinkPlaybackPhasePresentation>(
        GeneratedLinkNativeLegoCatalog.PortIds.LINK_PLAYBACK_PHASE_PRESENTATION_ADAPTER_PRESENTATION,
    ) {}
    val componentInputs: List<ProductComponentInput<GeneratedLinkPlaybackPhasePresentation>> = listOf(
        object : ProductComponentInput<GeneratedLinkPlaybackPhasePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.ACTIVE_PLAYBACK_PLAYBACKSTATE,
        ) {},
    )
    private val cases: Map<String, GeneratedLinkPlaybackPhasePresentation> = mapOf(
        "idle" to GeneratedLinkPlaybackPhasePresentation(phase = GeneratedLinkPlaybackPhaseValue.IDLE),
        "queued" to GeneratedLinkPlaybackPhasePresentation(phase = GeneratedLinkPlaybackPhaseValue.QUEUED),
        "playing" to GeneratedLinkPlaybackPhasePresentation(phase = GeneratedLinkPlaybackPhaseValue.PLAYING),
        "paused" to GeneratedLinkPlaybackPhasePresentation(phase = GeneratedLinkPlaybackPhaseValue.PAUSED),
        "stopped" to GeneratedLinkPlaybackPhasePresentation(phase = GeneratedLinkPlaybackPhaseValue.STOPPED),
        "played" to GeneratedLinkPlaybackPhasePresentation(phase = GeneratedLinkPlaybackPhaseValue.PLAYED),
        "skipped" to GeneratedLinkPlaybackPhasePresentation(phase = GeneratedLinkPlaybackPhaseValue.SKIPPED),
        "failed" to GeneratedLinkPlaybackPhasePresentation(phase = GeneratedLinkPlaybackPhaseValue.FAILED),
    )

    fun require(stateId: String): GeneratedLinkPlaybackPhasePresentation = requireNotNull(cases[stateId]) {
        "Unknown link.playback-phase state '$stateId'"
    }
}

internal data class GeneratedLinkTargetKindPresentation(
    val kind: GeneratedLinkTargetKindValue,
)

internal object GeneratedLinkTargetKindAuthority {
    fun <T : Any> inputPort(): ProductDataInput<T> = object : ProductDataInput<T>(
        GeneratedLinkNativeLegoCatalog.PortIds.LINK_TARGET_KIND_PRESENTATION_ADAPTER_STATE,
    ) {}
    val outputPort: ProductOutputPort<GeneratedLinkTargetKindPresentation> = object : ProductOutputPort<GeneratedLinkTargetKindPresentation>(
        GeneratedLinkNativeLegoCatalog.PortIds.LINK_TARGET_KIND_PRESENTATION_ADAPTER_PRESENTATION,
    ) {}
    val componentInputs: List<ProductComponentInput<GeneratedLinkTargetKindPresentation>> = listOf(
        object : ProductComponentInput<GeneratedLinkTargetKindPresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.TARGET_TARGETSTATE,
        ) {},
    )
    private val cases: Map<String, GeneratedLinkTargetKindPresentation> = mapOf(
        "none" to GeneratedLinkTargetKindPresentation(kind = GeneratedLinkTargetKindValue.NONE),
        "agent" to GeneratedLinkTargetKindPresentation(kind = GeneratedLinkTargetKindValue.AGENT),
        "windows" to GeneratedLinkTargetKindPresentation(kind = GeneratedLinkTargetKindValue.WINDOWS),
        "public" to GeneratedLinkTargetKindPresentation(kind = GeneratedLinkTargetKindValue.PUBLIC),
    )

    fun require(stateId: String): GeneratedLinkTargetKindPresentation = requireNotNull(cases[stateId]) {
        "Unknown link.target-kind state '$stateId'"
    }
}

internal data class GeneratedLinkConnectionStatePresentation(
    val connection: GeneratedLinkConnectionStateValue,
)

internal object GeneratedLinkConnectionStateAuthority {
    fun <T : Any> inputPort(): ProductDataInput<T> = object : ProductDataInput<T>(
        GeneratedLinkNativeLegoCatalog.PortIds.LINK_CONNECTION_STATE_PRESENTATION_ADAPTER_STATE,
    ) {}
    val outputPort: ProductOutputPort<GeneratedLinkConnectionStatePresentation> = object : ProductOutputPort<GeneratedLinkConnectionStatePresentation>(
        GeneratedLinkNativeLegoCatalog.PortIds.LINK_CONNECTION_STATE_PRESENTATION_ADAPTER_PRESENTATION,
    ) {}
    val componentInputs: List<ProductComponentInput<GeneratedLinkConnectionStatePresentation>> = listOf(
        object : ProductComponentInput<GeneratedLinkConnectionStatePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.CONNECTION_CONNECTIONSTATE,
        ) {},
        object : ProductComponentInput<GeneratedLinkConnectionStatePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.PUBLIC_LINK_CONNECTIONSTATE,
        ) {},
    )
    private val cases: Map<String, GeneratedLinkConnectionStatePresentation> = mapOf(
        "off" to GeneratedLinkConnectionStatePresentation(connection = GeneratedLinkConnectionStateValue.OFF),
        "connecting" to GeneratedLinkConnectionStatePresentation(connection = GeneratedLinkConnectionStateValue.CONNECTING),
        "connected" to GeneratedLinkConnectionStatePresentation(connection = GeneratedLinkConnectionStateValue.CONNECTED),
        "disconnected" to GeneratedLinkConnectionStatePresentation(connection = GeneratedLinkConnectionStateValue.DISCONNECTED),
        "configuration-required" to GeneratedLinkConnectionStatePresentation(connection = GeneratedLinkConnectionStateValue.CONFIGURATION_REQUIRED),
    )

    fun require(stateId: String): GeneratedLinkConnectionStatePresentation = requireNotNull(cases[stateId]) {
        "Unknown link.connection-state state '$stateId'"
    }
}

internal data class GeneratedLinkUpdatePhasePresentation(
    val phase: GeneratedLinkUpdatePhaseValue,
)

internal object GeneratedLinkUpdatePhaseAuthority {
    fun <T : Any> inputPort(): ProductDataInput<T> = object : ProductDataInput<T>(
        GeneratedLinkNativeLegoCatalog.PortIds.LINK_UPDATE_PHASE_PRESENTATION_ADAPTER_STATE,
    ) {}
    val outputPort: ProductOutputPort<GeneratedLinkUpdatePhasePresentation> = object : ProductOutputPort<GeneratedLinkUpdatePhasePresentation>(
        GeneratedLinkNativeLegoCatalog.PortIds.LINK_UPDATE_PHASE_PRESENTATION_ADAPTER_PRESENTATION,
    ) {}
    val componentInputs: List<ProductComponentInput<GeneratedLinkUpdatePhasePresentation>> = listOf(
        object : ProductComponentInput<GeneratedLinkUpdatePhasePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.UPDATES_UPDATESTATE,
        ) {},
    )
    private val cases: Map<String, GeneratedLinkUpdatePhasePresentation> = mapOf(
        "idle" to GeneratedLinkUpdatePhasePresentation(phase = GeneratedLinkUpdatePhaseValue.IDLE),
        "checking" to GeneratedLinkUpdatePhasePresentation(phase = GeneratedLinkUpdatePhaseValue.CHECKING),
        "up-to-date" to GeneratedLinkUpdatePhasePresentation(phase = GeneratedLinkUpdatePhaseValue.UP_TO_DATE),
        "unavailable" to GeneratedLinkUpdatePhasePresentation(phase = GeneratedLinkUpdatePhaseValue.UNAVAILABLE),
        "available" to GeneratedLinkUpdatePhasePresentation(phase = GeneratedLinkUpdatePhaseValue.AVAILABLE),
        "downloading" to GeneratedLinkUpdatePhasePresentation(phase = GeneratedLinkUpdatePhaseValue.DOWNLOADING),
        "ready-to-install" to GeneratedLinkUpdatePhasePresentation(phase = GeneratedLinkUpdatePhaseValue.READY_TO_INSTALL),
        "installing" to GeneratedLinkUpdatePhasePresentation(phase = GeneratedLinkUpdatePhaseValue.INSTALLING),
        "install-failed" to GeneratedLinkUpdatePhasePresentation(phase = GeneratedLinkUpdatePhaseValue.INSTALL_FAILED),
        "failed" to GeneratedLinkUpdatePhasePresentation(phase = GeneratedLinkUpdatePhaseValue.FAILED),
    )

    fun require(stateId: String): GeneratedLinkUpdatePhasePresentation = requireNotNull(cases[stateId]) {
        "Unknown link.update-phase state '$stateId'"
    }
}

internal data class GeneratedLinkRecoveryPhasePresentation(
    val phase: GeneratedLinkRecoveryPhaseValue,
)

internal object GeneratedLinkRecoveryPhaseAuthority {
    fun <T : Any> inputPort(): ProductDataInput<T> = object : ProductDataInput<T>(
        GeneratedLinkNativeLegoCatalog.PortIds.LINK_RECOVERY_PHASE_PRESENTATION_ADAPTER_STATE,
    ) {}
    val outputPort: ProductOutputPort<GeneratedLinkRecoveryPhasePresentation> = object : ProductOutputPort<GeneratedLinkRecoveryPhasePresentation>(
        GeneratedLinkNativeLegoCatalog.PortIds.LINK_RECOVERY_PHASE_PRESENTATION_ADAPTER_PRESENTATION,
    ) {}
    val componentInputs: List<ProductComponentInput<GeneratedLinkRecoveryPhasePresentation>> = listOf(
        object : ProductComponentInput<GeneratedLinkRecoveryPhasePresentation>(
            GeneratedLinkNativeLegoCatalog.PortIds.RECOVERY_RECOVERYSTATE,
        ) {},
    )
    private val cases: Map<String, GeneratedLinkRecoveryPhasePresentation> = mapOf(
        "clean" to GeneratedLinkRecoveryPhasePresentation(phase = GeneratedLinkRecoveryPhaseValue.CLEAN),
        "quarantined" to GeneratedLinkRecoveryPhasePresentation(phase = GeneratedLinkRecoveryPhaseValue.QUARANTINED),
    )

    fun require(stateId: String): GeneratedLinkRecoveryPhasePresentation = requireNotNull(cases[stateId]) {
        "Unknown link.recovery-phase state '$stateId'"
    }
}

