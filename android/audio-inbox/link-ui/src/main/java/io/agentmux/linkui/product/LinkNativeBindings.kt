package io.agentmux.linkui.product

import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.runtime.Composable
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
import io.agentmux.linkui.product.generated.GeneratedLinkNodeId
import io.agentmux.linkui.product.generated.GeneratedLinkPageId
import io.agentmux.linkui.product.generated.GeneratedLinkPlaybackPhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkRecoveryPhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkReplyPhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkTargetKindAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkUpdatePhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkRendererEventId
import io.agentmux.linkui.product.generated.GeneratedLinkRendererInputId
import io.agentmux.linkui.product.generated.GeneratedLinkRendererScopeId
import kotlin.enums.enumEntries

data class LinkNativeRendererMountRegistration(
    val scope: GeneratedLinkRendererScopeId,
    val mount: @Composable (inputs: Any, emitter: Any) -> Unit,
)

data class LinkNativeRendererInputRegistration(
    val input: GeneratedLinkRendererInputId,
    val read: () -> Any,
)

data class LinkNativeRendererEventRegistration(
    val event: GeneratedLinkRendererEventId,
    val emit: (payload: Any) -> Unit,
)

sealed interface LinkNativeRendererEmitterRegistration {
    data class Typed(val bindings: List<LinkNativeRendererEventRegistration>) :
        LinkNativeRendererEmitterRegistration
    data class Empty(val emit: (Nothing) -> Nothing = { error("read-only renderer emitted an event") }) :
        LinkNativeRendererEmitterRegistration
}

data class LinkNativeComponentRendererRegistration(
    val component: GeneratedLinkComponentId,
    val mounts: List<LinkNativeRendererMountRegistration>,
    val immutableInputs: List<LinkNativeRendererInputRegistration>,
    val eventEmitter: LinkNativeRendererEmitterRegistration,
) {
    init {
        require(mounts.isNotEmpty())
        require(mounts.all { it.scope.declaration.component == component })
        require(immutableInputs.all { it.input.declaration.component == component })
        val events = (eventEmitter as? LinkNativeRendererEmitterRegistration.Typed)?.bindings.orEmpty()
        require(events.all { it.event.declaration.component == component })
        require(mounts.map { it.scope }.distinct().size == mounts.size)
        require(immutableInputs.map { it.input }.distinct().size == immutableInputs.size)
        require(events.map { it.event }.distinct().size == events.size)
    }
}

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

internal enum class LinkNativePageRestore(val wireId: String) {
    ROOT("root"),
    PROCESS("process"),
}

internal enum class LinkNativePageBack(val wireId: String) {
    PREVIOUS("previous"),
    CONSUME("consume"),
    SYSTEM("system"),
}

internal data class LinkNativePageBinding(
    val page: GeneratedLinkPageId,
    val restore: LinkNativePageRestore,
    val back: LinkNativePageBack,
    val guardContractRef: String? = null,
)

internal data class LinkNativeNavigationArtifactBinding(
    val artifact: GeneratedLinkArtifactRef,
    val entryPage: GeneratedLinkPageId,
    val pages: List<LinkNativePageBinding>,
) {
    init {
        require(pages.map { it.page }.distinct().size == pages.size)
        require(pages.any { it.page == entryPage && it.restore == LinkNativePageRestore.ROOT })
    }

    fun requirePage(page: GeneratedLinkPageId): LinkNativePageBinding =
        requireNotNull(pages.singleOrNull { it.page == page }) {
            "Page ${page.wireId} is outside ${artifact.wireId}"
        }
}

internal data class LinkNativeActivePageBinding(
    val publisher: LinkNativeOutputPortBinding,
    val pageHost: ProductComponentInput<*>,
)

internal enum class LinkNativeActionEffect(val wireId: String) {
    PUSH("push"),
    DISPATCH("dispatch"),
}

internal data class LinkNativeActionBinding(
    val source: ProductComponentEvent<*, *>,
    val target: LinkNativeInputPortBinding,
    val effect: LinkNativeActionEffect,
)

internal data class LinkNativeActionGroupBinding(
    val artifact: GeneratedLinkArtifactRef,
    val component: GeneratedLinkComponentId,
    val actions: List<LinkNativeActionBinding>,
)

/**
 * Shared node/navigation registrations composed into each host's schema-6 manifest.
 * Every entry binds a generated component/artifact id or a compile-checked
 * RingIcons/enum symbol, so a product change that drops one fails here at
 * compile time, and the manifest/parity tests fail on any other drift.
 */
object LinkNativeBindings {
    const val SCHEMA_VERSION = 6
    const val SOURCE_FILE =
        "link-ui/src/main/java/io/agentmux/linkui/product/LinkNativeBindings.kt"

    val profiles: Set<GeneratedLinkArtifactRef> = GeneratedLinkArtifactRef.entries.toSet()
    private val both = profiles

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
            listOf(NavigationOpenSettingsInput, NavigationOpenDevHostInput, NavigationBackInput),
            listOf(NavigationActivePageOutput),
        ),
        node(
            GeneratedLinkNodeId.CAPTURE_SERVICE,
            listOf(CaptureCommandInput),
            listOf(CaptureStatusOutput, CaptureCapturedOutput),
        ),
        node(
            GeneratedLinkNodeId.CONVERSATION_SERVICE,
            listOf(ConversationTurnInput, ConversationComposeInput, ConversationEditInput),
            listOf(ConversationStatusOutput),
        ),
        node(
            GeneratedLinkNodeId.PLAYBACK_SERVICE,
            listOf(PlaybackCommandInput, PlaybackLatestCommandInput),
            listOf(PlaybackStatusOutput),
        ),
        node(
            GeneratedLinkNodeId.TARGET_SERVICE,
            listOf(TargetSelectInput),
            listOf(TargetDirectoryOutput),
        ),
        node(GeneratedLinkNodeId.SESSION_SERVICE, listOf(SessionCommandInput), listOf(SessionStatusOutput)),
        node(GeneratedLinkNodeId.HOST_SERVICE, listOf(HostOpenAttachmentInput), emptyList()),
        node(GeneratedLinkNodeId.DEV_PREVIEW_SERVICE, emptyList(), listOf(DevPreviewStatusOutput)),
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
            GeneratedLinkNodeId.DEV_PREVIEW_PRESENTATION,
            listOf(DevPreviewPresentationSourceInput),
            listOf(DevPreviewPresentationModelOutput),
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
            FiniteValueIds.LINK_NAVIGATION_PAGE,
            GeneratedLinkPageId.entries.mapTo(linkedSetOf()) { it.wireId },
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

    internal val navigationArtifacts: List<LinkNativeNavigationArtifactBinding> = listOf(
        LinkNativeNavigationArtifactBinding(
            artifact = GeneratedLinkArtifactRef.PHONE_FULL_UI,
            entryPage = GeneratedLinkPageId.HOME,
            pages = listOf(
                page(GeneratedLinkPageId.HOME, LinkNativePageRestore.ROOT, LinkNativePageBack.SYSTEM),
                page(GeneratedLinkPageId.SETTINGS, LinkNativePageRestore.PROCESS, LinkNativePageBack.PREVIOUS),
                page(GeneratedLinkPageId.DEV_HOST, LinkNativePageRestore.PROCESS, LinkNativePageBack.PREVIOUS),
            ),
        ),
        LinkNativeNavigationArtifactBinding(
            artifact = GeneratedLinkArtifactRef.WEAR_FULL_UI,
            entryPage = GeneratedLinkPageId.HOME,
            pages = listOf(
                page(GeneratedLinkPageId.HOME, LinkNativePageRestore.ROOT, LinkNativePageBack.SYSTEM),
                page(GeneratedLinkPageId.SETTINGS, LinkNativePageRestore.PROCESS, LinkNativePageBack.PREVIOUS),
            ),
        ),
    )

    internal val activePageBindings: List<LinkNativeActivePageBinding> = listOf(
        LinkNativeActivePageBinding(NavigationActivePageOutput, PageHostActivePageInput),
    )

    internal val actionGroups: List<LinkNativeActionGroupBinding> = listOf(
        actionGroup(GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkComponentId.ACTIVE_PLAYBACK,
            action(ActivePlaybackCommandEvent, PlaybackCommandInput)),
        actionGroup(GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkComponentId.COMPOSER,
            action(ComposerComposeEvent, ConversationComposeInput),
            action(ComposerEditEvent, ConversationEditInput)),
        actionGroup(GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkComponentId.LATEST,
            action(LatestPlaybackCommandEvent, PlaybackLatestCommandInput),
            action(LatestOpenAttachmentEvent, HostOpenAttachmentInput)),
        actionGroup(GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkComponentId.PUBLIC_LINK,
            action(PublicLinkCommandEvent, SessionCommandInput)),
        actionGroup(GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkComponentId.DEV_HOST,
            action(DevHostOpenEvent, NavigationOpenDevHostInput, LinkNativeActionEffect.PUSH)),
        actionGroup(GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkComponentId.DEV_PREVIEW,
            action(DevPreviewBackEvent, NavigationBackInput)),
        actionGroup(GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkComponentId.PREFERENCES,
            action(PreferencesToggleEvent, PreferencesToggleInput)),
        actionGroup(GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkComponentId.SETTINGS_ACTION,
            action(SettingsActionOpenEvent, NavigationOpenSettingsInput, LinkNativeActionEffect.PUSH)),
        actionGroup(GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkComponentId.TALK,
            action(TalkCommandEvent, CaptureCommandInput)),
        actionGroup(GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkComponentId.TARGET,
            action(TargetSelectEvent, TargetSelectInput)),
        actionGroup(GeneratedLinkArtifactRef.PHONE_FULL_UI, GeneratedLinkComponentId.UPDATES,
            action(UpdatesCommandEvent, UpdatesCommandInput)),
        actionGroup(GeneratedLinkArtifactRef.WEAR_FULL_UI, GeneratedLinkComponentId.SETTINGS_ACTION,
            action(SettingsActionOpenEvent, NavigationOpenSettingsInput, LinkNativeActionEffect.PUSH)),
        actionGroup(GeneratedLinkArtifactRef.WEAR_FULL_UI, GeneratedLinkComponentId.TALK,
            action(TalkCommandEvent, CaptureCommandInput)),
        actionGroup(GeneratedLinkArtifactRef.WEAR_FULL_UI, GeneratedLinkComponentId.TARGET,
            action(TargetSelectEvent, TargetSelectInput)),
        actionGroup(GeneratedLinkArtifactRef.WEAR_FULL_UI, GeneratedLinkComponentId.UPDATES,
            action(UpdatesCommandEvent, UpdatesCommandInput)),
        actionGroup(GeneratedLinkArtifactRef.WEAR_FULL_UI, GeneratedLinkComponentId.LATEST,
            action(LatestPlaybackCommandEvent, PlaybackLatestCommandInput),
            action(LatestOpenAttachmentEvent, HostOpenAttachmentInput)),
    )

    init {
        val graph = ProductPortGraph()
        actionGroups.flatMap { it.actions }.forEach { action ->
            val generated = graph.requireComponentEventBinding(action.source)
            require(generated.to == action.target.id) {
                "Action ${action.source.id.value} targets ${generated.to.value}, not ${action.target.id.value}"
            }
        }
    }

    fun requireIcon(iconId: String): ImageVector =
        requireNotNull(icons.singleOrNull { it.iconId == iconId }) {
            "No native Link icon binding for $iconId"
        }.icon

    private fun icon(id: String, symbol: String, value: ImageVector) =
        LinkNativeIconBinding(id, symbol, value)

    private fun finiteValues(id: GeneratedLinkFiniteValueId, values: Set<String>) =
        LinkNativeFiniteValueBinding(id, values)

    internal fun requireNavigationArtifact(
        artifact: GeneratedLinkArtifactRef,
    ): LinkNativeNavigationArtifactBinding =
        requireNotNull(navigationArtifacts.singleOrNull { it.artifact == artifact }) {
            "No native Link navigation registration for ${artifact.wireId}"
        }

    private fun page(
        id: GeneratedLinkPageId,
        restore: LinkNativePageRestore,
        back: LinkNativePageBack,
    ) = LinkNativePageBinding(id, restore, back)

    private fun actionGroup(
        artifact: GeneratedLinkArtifactRef,
        component: GeneratedLinkComponentId,
        vararg actions: LinkNativeActionBinding,
    ) = LinkNativeActionGroupBinding(artifact, component, actions.toList())

    private fun action(
        source: ProductComponentEvent<*, *>,
        target: LinkNativeInputPortBinding,
        effect: LinkNativeActionEffect = LinkNativeActionEffect.DISPATCH,
    ) = LinkNativeActionBinding(source, target, effect)

    private fun node(
        id: GeneratedLinkNodeId,
        inputs: List<LinkNativeInputPortBinding>,
        outputs: List<LinkNativeOutputPortBinding>,
    ) = LinkNativeNodeBinding(id, both, inputs, outputs)

    /** Kotlin constants stay platform idiom; the attested wire value is lowercase kebab. */
    private inline fun <reified E : Enum<E>> wireValues(): Set<String> =
        enumEntries<E>().mapTo(linkedSetOf()) { it.name.lowercase().replace('_', '-') }
}
