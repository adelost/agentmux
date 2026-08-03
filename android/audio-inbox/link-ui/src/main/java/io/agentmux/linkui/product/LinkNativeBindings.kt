package io.agentmux.linkui.product

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import com.adelost.designkit.ui.GraphiteTokens
import com.adelost.designkit.ui.RingIcons

const val LINK_PHONE_PROFILE = "phone-full-ui"
const val LINK_WEAR_PROFILE = "wear-full-ui"

enum class LinkNativeComponentRenderer(val id: String) {
    STATUS("status"),
    CONVERSATION_FEED("conversation-feed"),
    COMPOSER("composer"),
    CAPTURE("capture"),
    ACTIVE_PLAYBACK("active-playback"),
    CONNECTION("connection"),
    PUBLIC_LINK("public-link"),
    PREFERENCES("preferences"),
    LOCAL_HISTORY("local-history"),
    UPDATES("updates"),
    DEV_HOST("dev-host"),
    RECOVERY("recovery"),
    DEV_PREVIEW("dev-preview"),
}

enum class LinkNativeServicePort(val id: String) {
    NAVIGATION("link.navigation.port"),
    CAPTURE("link.capture.port"),
    CONVERSATION("link.conversation.port"),
    PLAYBACK("link.playback.port"),
}

data class LinkNativeComponentBinding(
    val componentId: String,
    val renderer: LinkNativeComponentRenderer,
    val profiles: Set<String>,
)

data class LinkNativeIconBinding(
    val iconId: String,
    val nativeSymbol: String,
    val icon: ImageVector,
)

data class LinkNativePaletteBinding(
    val paletteId: String,
    val nativeSymbol: String,
    val canvas: Color,
    val profiles: Set<String>,
)

data class LinkNativeServiceBinding(
    val serviceId: String,
    val port: LinkNativeServicePort,
    val profiles: Set<String>,
    val inputPorts: Set<String>,
    val outputPorts: Set<String>,
)

/**
 * Handwritten Android truth. It deliberately imports no generated ProductSpec
 * output, so generation cannot certify itself when a real native binding drifts.
 */
object LinkNativeBindings {
    const val SCHEMA_VERSION = 1
    const val SOURCE_FILE =
        "link-ui/src/main/java/io/agentmux/linkui/product/LinkNativeBindings.kt"

    val profiles: Set<String> = setOf(LINK_PHONE_PROFILE, LINK_WEAR_PROFILE)
    private val both = profiles
    private val phone = setOf(LINK_PHONE_PROFILE)

    val components: List<LinkNativeComponentBinding> = listOf(
        component("target", LinkNativeComponentRenderer.STATUS, both),
        component("latest", LinkNativeComponentRenderer.CONVERSATION_FEED, both),
        component("composer", LinkNativeComponentRenderer.COMPOSER, phone),
        component("talk", LinkNativeComponentRenderer.CAPTURE, both),
        component("active-playback", LinkNativeComponentRenderer.ACTIVE_PLAYBACK, phone),
        component("connection", LinkNativeComponentRenderer.CONNECTION, both),
        component("public-link", LinkNativeComponentRenderer.PUBLIC_LINK, phone),
        component("preferences", LinkNativeComponentRenderer.PREFERENCES, phone),
        component("local-history", LinkNativeComponentRenderer.LOCAL_HISTORY, phone),
        component("updates", LinkNativeComponentRenderer.UPDATES, both),
        component("dev-host", LinkNativeComponentRenderer.DEV_HOST, phone),
        component("recovery", LinkNativeComponentRenderer.RECOVERY, both),
        component("dev-preview", LinkNativeComponentRenderer.DEV_PREVIEW, phone),
    )

    val icons: List<LinkNativeIconBinding> = listOf(
        icon("link", "RingIcons.Link", RingIcons.Link),
        icon("gear", "RingIcons.Gear", RingIcons.Gear),
        icon("phone", "RingIcons.Phone", RingIcons.Phone),
        icon("target", "RingIcons.Target", RingIcons.Target),
        icon("speaker", "RingIcons.Speaker", RingIcons.Speaker),
        icon("pencil", "RingIcons.Pencil", RingIcons.Pencil),
        icon("record", "RingIcons.Record", RingIcons.Record),
        icon("play", "RingIcons.Play", RingIcons.Play),
        icon("wifi", "RingIcons.Wifi", RingIcons.Wifi),
        icon("activity", "RingIcons.Activity", RingIcons.Activity),
        icon("download", "RingIcons.Download", RingIcons.Download),
        icon("warning", "RingIcons.Warning", RingIcons.Warning),
    )

    val palettes: List<LinkNativePaletteBinding> = listOf(
        LinkNativePaletteBinding(
            paletteId = "graphite",
            nativeSymbol = "GraphiteTokens.Canvas",
            canvas = GraphiteTokens.Canvas,
            profiles = both,
        ),
    )

    val services: List<LinkNativeServiceBinding> = listOf(
        service("navigation", LinkNativeServicePort.NAVIGATION, setOf("open"), setOf("destination")),
        service("capture", LinkNativeServicePort.CAPTURE, setOf("command"), setOf("status", "captured")),
        service("conversation", LinkNativeServicePort.CONVERSATION, setOf("turn"), setOf("status")),
        service("playback", LinkNativeServicePort.PLAYBACK, setOf("command"), setOf("status")),
    )

    fun requireComponent(componentId: String): LinkNativeComponentBinding =
        requireNotNull(components.singleOrNull { it.componentId == componentId }) {
            "No native Link component binding for $componentId"
        }

    fun requireIcon(iconId: String): ImageVector =
        requireNotNull(icons.singleOrNull { it.iconId == iconId }) {
            "No native Link icon binding for $iconId"
        }.icon

    private fun component(
        id: String,
        renderer: LinkNativeComponentRenderer,
        supportedProfiles: Set<String>,
    ) = LinkNativeComponentBinding(id, renderer, supportedProfiles)

    private fun icon(id: String, symbol: String, value: ImageVector) =
        LinkNativeIconBinding(id, symbol, value)

    private fun service(
        id: String,
        port: LinkNativeServicePort,
        inputs: Set<String>,
        outputs: Set<String>,
    ) = LinkNativeServiceBinding(id, port, both, inputs, outputs)
}
