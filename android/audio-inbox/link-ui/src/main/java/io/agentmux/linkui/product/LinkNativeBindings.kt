package io.agentmux.linkui.product

import androidx.compose.ui.graphics.vector.ImageVector
import com.adelost.designkit.ui.RingIcons
import io.agentmux.linkcore.CaptureOperation
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkPreferenceKey
import io.agentmux.linkcore.LinkRecoveryPhase
import io.agentmux.linkcore.LinkTargetKind
import io.agentmux.linkcore.LinkUpdateOperation
import io.agentmux.linkcore.LinkUpdatePhase
import io.agentmux.linkcore.PlaybackOperation
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.ReplyPhase
import io.agentmux.linkui.product.generated.GeneratedLinkArtifactRef
import io.agentmux.linkui.product.generated.GeneratedLinkComponentId
import io.agentmux.linkui.product.generated.GeneratedLinkFiniteValueId
import io.agentmux.linkui.product.generated.GeneratedLinkNativeLegoCatalog.FiniteValueIds
import io.agentmux.linkui.product.generated.GeneratedLinkCapturePhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkConnectionStateAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkDeliveryPhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkNavigationRouteAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkNodeId
import io.agentmux.linkui.product.generated.GeneratedLinkPlaybackPhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkRecoveryPhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkReplyPhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkTargetKindAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkUpdatePhaseAuthority
import kotlin.enums.enumEntries

/** One component instance attested to a native renderer and its host artifacts. */
data class LinkNativeComponentBinding(
    val component: GeneratedLinkComponentId,
    val rendererId: String,
    val profiles: Set<GeneratedLinkArtifactRef>,
)

/** One portable icon asset attested to its compile-bound CircleKit symbol. */
data class LinkNativeIconBinding(
    val iconId: String,
    val nativeSymbol: String,
    val icon: ImageVector,
)

/** One generated finite-value declaration attested to its native enum's wire values. */
internal data class LinkNativeFiniteValueBinding(
    val id: GeneratedLinkFiniteValueId,
    val values: Set<String>,
)

/** One native node implementation and every compile-bound port it mounts. */
internal data class LinkNativeNodeBinding(
    val node: GeneratedLinkNodeId,
    val profiles: Set<GeneratedLinkArtifactRef>,
    val inputPorts: List<LinkNativeInputPortBinding>,
    val outputPorts: List<LinkNativeOutputPortBinding>,
) {
    val nativePortId: String get() = node.wireId
}

/**
 * The native attestation named by product-spec/native-registry/link.json.
 * Every entry binds a generated component/artifact id or a compile-checked
 * RingIcons/enum symbol, so a product change that drops one fails here at
 * compile time, and the manifest/parity tests fail on any other drift.
 */
object LinkNativeBindings {
    const val SCHEMA_VERSION = 4
    const val SOURCE_FILE =
        "link-ui/src/main/java/io/agentmux/linkui/product/LinkNativeBindings.kt"

    val profiles: Set<GeneratedLinkArtifactRef> = GeneratedLinkArtifactRef.entries.toSet()
    private val both = profiles
    private val phone = setOf(GeneratedLinkArtifactRef.PHONE_FULL_UI)

    val components: List<LinkNativeComponentBinding> = listOf(
        component(GeneratedLinkComponentId.TARGET, "status", both),
        component(GeneratedLinkComponentId.LATEST, "conversation-feed", both),
        component(GeneratedLinkComponentId.COMPOSER, "composer", phone),
        component(GeneratedLinkComponentId.TALK, "capture", both),
        component(GeneratedLinkComponentId.ACTIVE_PLAYBACK, "active-playback", phone),
        component(GeneratedLinkComponentId.CONNECTION, "connection", both),
        component(GeneratedLinkComponentId.PUBLIC_LINK, "public-link", phone),
        component(GeneratedLinkComponentId.PREFERENCES, "preferences", phone),
        component(GeneratedLinkComponentId.LOCAL_HISTORY, "local-history", phone),
        component(GeneratedLinkComponentId.UPDATES, "updates", both),
        component(GeneratedLinkComponentId.RECOVERY, "recovery", both),
        component(GeneratedLinkComponentId.SETTINGS_ACTION, "navigation-entry", both),
        component(GeneratedLinkComponentId.DEV_HOST, "navigation-entry", phone),
        component(GeneratedLinkComponentId.DEV_PREVIEW, "dev-preview", phone),
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

    internal val nodes: List<LinkNativeNodeBinding> = listOf(
        node(
            GeneratedLinkNodeId.NAVIGATION_SERVICE,
            listOf(NavigationOpenSettingsInput, NavigationOpenDevHostInput),
            listOf(NavigationDestinationOutput),
        ),
        node(
            GeneratedLinkNodeId.CAPTURE_SERVICE,
            listOf(CaptureCommandInput),
            listOf(CaptureStatusOutput, CaptureCapturedOutput),
        ),
        node(
            GeneratedLinkNodeId.CONVERSATION_SERVICE,
            listOf(ConversationTurnInput, ConversationComposeInput),
            listOf(ConversationStatusOutput),
        ),
        node(
            GeneratedLinkNodeId.PLAYBACK_SERVICE,
            listOf(PlaybackCommandInput),
            listOf(PlaybackStatusOutput),
        ),
        node(
            GeneratedLinkNodeId.TARGET_SERVICE,
            listOf(TargetSelectInput),
            listOf(TargetDirectoryOutput),
        ),
        node(GeneratedLinkNodeId.SESSION_SERVICE, emptyList(), listOf(SessionStatusOutput)),
        node(GeneratedLinkNodeId.HISTORY_SERVICE, emptyList(), listOf(HistoryStatusOutput)),
        node(
            GeneratedLinkNodeId.PREFERENCES_SERVICE,
            listOf(PreferencesToggleInput),
            listOf(PreferencesStatusOutput),
        ),
        node(
            GeneratedLinkNodeId.UPDATES_SERVICE,
            listOf(UpdatesCommandInput),
            listOf(UpdatesStatusOutput),
        ),
        node(GeneratedLinkNodeId.RECOVERY_SERVICE, emptyList(), listOf(RecoveryStatusOutput)),
        node(
            GeneratedLinkNodeId.NAVIGATION_PRESENTATION,
            listOf(NavigationPresentationSourceInput),
            listOf(NavigationPresentationModelOutput),
        ),
        node(
            GeneratedLinkNodeId.CAPTURE_PRESENTATION,
            listOf(CapturePresentationSourceInput),
            listOf(CapturePresentationModelOutput),
        ),
        node(
            GeneratedLinkNodeId.CONVERSATION_PRESENTATION,
            listOf(ConversationPresentationSourceInput),
            listOf(ConversationPresentationModelOutput),
        ),
        node(
            GeneratedLinkNodeId.PLAYBACK_PRESENTATION,
            listOf(PlaybackPresentationSourceInput),
            listOf(PlaybackPresentationModelOutput),
        ),
        node(
            GeneratedLinkNodeId.TARGET_PRESENTATION,
            listOf(TargetPresentationSourceInput),
            listOf(TargetPresentationModelOutput),
        ),
        node(
            GeneratedLinkNodeId.SESSION_PRESENTATION,
            listOf(SessionPresentationSourceInput),
            listOf(SessionPresentationModelOutput),
        ),
        node(
            GeneratedLinkNodeId.HISTORY_PRESENTATION,
            listOf(HistoryPresentationSourceInput),
            listOf(HistoryPresentationModelOutput),
        ),
        node(
            GeneratedLinkNodeId.PREFERENCES_PRESENTATION,
            listOf(PreferencesPresentationSourceInput),
            listOf(PreferencesPresentationModelOutput),
        ),
        node(
            GeneratedLinkNodeId.UPDATES_PRESENTATION,
            listOf(UpdatesPresentationSourceInput),
            listOf(UpdatesPresentationModelOutput),
        ),
        node(
            GeneratedLinkNodeId.RECOVERY_PRESENTATION,
            listOf(RecoveryPresentationSourceInput),
            listOf(RecoveryPresentationModelOutput),
        ),
        node(
            GeneratedLinkNodeId.LINK_NAVIGATION_ROUTE_PRESENTATION_ADAPTER,
            listOf(GeneratedLinkNavigationRouteAuthority.inputPort<Any>()),
            listOf(GeneratedLinkNavigationRouteAuthority.outputPort),
        ),
        node(
            GeneratedLinkNodeId.LINK_CAPTURE_PHASE_PRESENTATION_ADAPTER,
            listOf(GeneratedLinkCapturePhaseAuthority.inputPort<Any>()),
            listOf(GeneratedLinkCapturePhaseAuthority.outputPort),
        ),
        node(
            GeneratedLinkNodeId.LINK_DELIVERY_PHASE_PRESENTATION_ADAPTER,
            listOf(GeneratedLinkDeliveryPhaseAuthority.inputPort<Any>()),
            listOf(GeneratedLinkDeliveryPhaseAuthority.outputPort),
        ),
        node(
            GeneratedLinkNodeId.LINK_REPLY_PHASE_PRESENTATION_ADAPTER,
            listOf(GeneratedLinkReplyPhaseAuthority.inputPort<Any>()),
            listOf(GeneratedLinkReplyPhaseAuthority.outputPort),
        ),
        node(
            GeneratedLinkNodeId.LINK_PLAYBACK_PHASE_PRESENTATION_ADAPTER,
            listOf(GeneratedLinkPlaybackPhaseAuthority.inputPort<Any>()),
            listOf(GeneratedLinkPlaybackPhaseAuthority.outputPort),
        ),
        node(
            GeneratedLinkNodeId.LINK_TARGET_KIND_PRESENTATION_ADAPTER,
            listOf(GeneratedLinkTargetKindAuthority.inputPort<Any>()),
            listOf(GeneratedLinkTargetKindAuthority.outputPort),
        ),
        node(
            GeneratedLinkNodeId.LINK_CONNECTION_STATE_PRESENTATION_ADAPTER,
            listOf(GeneratedLinkConnectionStateAuthority.inputPort<Any>()),
            listOf(GeneratedLinkConnectionStateAuthority.outputPort),
        ),
        node(
            GeneratedLinkNodeId.LINK_UPDATE_PHASE_PRESENTATION_ADAPTER,
            listOf(GeneratedLinkUpdatePhaseAuthority.inputPort<Any>()),
            listOf(GeneratedLinkUpdatePhaseAuthority.outputPort),
        ),
        node(
            GeneratedLinkNodeId.LINK_RECOVERY_PHASE_PRESENTATION_ADAPTER,
            listOf(GeneratedLinkRecoveryPhaseAuthority.inputPort<Any>()),
            listOf(GeneratedLinkRecoveryPhaseAuthority.outputPort),
        ),
    )

    internal val finiteValues: List<LinkNativeFiniteValueBinding> = listOf(
        LinkNativeFiniteValueBinding(
            FiniteValueIds.LINK_ROUTE,
            LinkRoute.entries.mapTo(linkedSetOf()) { it.wireId },
        ),
        finiteValues(FiniteValueIds.LINK_CAPTURE_OPERATION, wireValues<CaptureOperation>()),
        finiteValues(FiniteValueIds.LINK_CAPTURE_PHASE, wireValues<CapturePhase>()),
        finiteValues(FiniteValueIds.LINK_DELIVERY_PHASE, wireValues<DeliveryPhase>()),
        finiteValues(FiniteValueIds.LINK_REPLY_PHASE, wireValues<ReplyPhase>()),
        finiteValues(FiniteValueIds.LINK_PLAYBACK_OPERATION, wireValues<PlaybackOperation>()),
        finiteValues(FiniteValueIds.LINK_PLAYBACK_PHASE, wireValues<PlaybackPhase>()),
        finiteValues(FiniteValueIds.LINK_TARGET_KIND, wireValues<LinkTargetKind>()),
        finiteValues(FiniteValueIds.LINK_CONNECTION_STATE, wireValues<ConnectionState>()),
        finiteValues(FiniteValueIds.LINK_PREFERENCE_KEY, wireValues<LinkPreferenceKey>()),
        finiteValues(FiniteValueIds.LINK_UPDATE_OPERATION, wireValues<LinkUpdateOperation>()),
        finiteValues(FiniteValueIds.LINK_UPDATE_PHASE, wireValues<LinkUpdatePhase>()),
        finiteValues(FiniteValueIds.LINK_RECOVERY_PHASE, wireValues<LinkRecoveryPhase>()),
    )

    init {
        components.groupBy { it.component.typeId }.forEach { (typeId, instances) ->
            require(instances.map { it.rendererId }.distinct().size == 1) {
                "Component type $typeId is attested to more than one renderer"
            }
        }
    }

    fun requireIcon(iconId: String): ImageVector =
        requireNotNull(icons.singleOrNull { it.iconId == iconId }) {
            "No native Link icon binding for $iconId"
        }.icon

    private fun component(
        id: GeneratedLinkComponentId,
        rendererId: String,
        supportedProfiles: Set<GeneratedLinkArtifactRef>,
    ) = LinkNativeComponentBinding(id, rendererId, supportedProfiles)

    private fun icon(id: String, symbol: String, value: ImageVector) =
        LinkNativeIconBinding(id, symbol, value)

    private fun finiteValues(id: GeneratedLinkFiniteValueId, values: Set<String>) =
        LinkNativeFiniteValueBinding(id, values)

    private fun node(
        id: GeneratedLinkNodeId,
        inputs: List<LinkNativeInputPortBinding>,
        outputs: List<LinkNativeOutputPortBinding>,
    ) = LinkNativeNodeBinding(id, both, inputs, outputs)

    /** Kotlin constants stay platform idiom; the attested wire value is lowercase kebab. */
    private inline fun <reified E : Enum<E>> wireValues(): Set<String> =
        enumEntries<E>().mapTo(linkedSetOf()) { it.name.lowercase().replace('_', '-') }
}
