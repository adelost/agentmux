package io.agentmux.linkui.product

import com.adelost.releasekit.UpdateState
import io.agentmux.linkcore.CaptureOperation
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTargetKind
import io.agentmux.linkui.LinkCaptureSpec
import io.agentmux.linkui.product.generated.GeneratedCapturePhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedSessionConnectionStateAuthority
import io.agentmux.linkui.product.generated.GeneratedConversationDeliveryPhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedPlaybackPhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedRecoveryPhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedConversationReplyPhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedTargetKindAuthority
import io.agentmux.linkui.product.generated.GeneratedUpdatesPhaseAuthority
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

/** The host-supplied native sinks behind the generated effect-owning service inputs. */
class LinkProductSinks(
    val captureCommand: (LinkCaptureCommandEvent) -> Unit,
    val capturedTurn: (LinkCapturedTurn) -> Unit,
    val compose: (LinkComposeEvent) -> Unit,
    val playbackCommand: (LinkPlaybackCommandEvent) -> Unit,
    val targetSelect: (LinkTargetSelectEvent) -> Unit,
    val preferenceToggle: (LinkPreferenceToggleEvent) -> Unit,
    val updateCommand: (LinkUpdateCommandEvent) -> Unit,
)

/**
 * The native half of the mandatory product graph for one Link host.
 *
 * The constructor mounts the whole boundary and proves it: every generated
 * service output is observed from the real host state, every node input has
 * exactly one native consumer, and every component model/destination
 * input and component event has its one native endpoint. Screens only read
 * the exposed component StateFlows and emit through the on... methods.
 */
open class LinkProductGraph(
    protected val processScope: CoroutineScope,
    private val state: StateFlow<LinkState>,
    updateState: StateFlow<UpdateState>,
    microphoneGranted: StateFlow<Boolean>,
    speakReplies: StateFlow<Boolean>,
    publicLinkActive: () -> Boolean,
    targetKindOf: (String) -> LinkTargetKind?,
    captureByteCount: () -> Long,
    captureByteLimit: () -> Long?,
    capturedTurns: Flow<LinkCapturedTurn>,
    val navigation: LinkNavigationController,
    private val sinks: LinkProductSinks,
) {
    private val runtime = LinkProductPortRuntime(processScope)

    val target: StateFlow<LinkTargetPresentation>
    val capture: StateFlow<LinkCapturePresentation>
    val latest: StateFlow<LinkConversationPresentation>
    val composerModel: StateFlow<LinkConversationPresentation>
    val activePlayback: StateFlow<LinkPlaybackPresentation>
    val connection: StateFlow<LinkSessionPresentation>
    val publicLink: StateFlow<LinkSessionPresentation>
    val preferences: StateFlow<LinkPreferencesPresentation>
    val localHistory: StateFlow<LinkHistoryPresentation>
    val updates: StateFlow<LinkUpdatePresentation>
    val recovery: StateFlow<LinkRecoveryPresentation>
    val activePage: StateFlow<LinkRoute>

    /** The capture control's host-neutral spec, derived beside the talk model. */
    val captureSpec: StateFlow<LinkCaptureSpec> = combine(
        state,
        microphoneGranted,
    ) { current, granted ->
        LinkCaptureSpec(
            phase = current.capture,
            startedAtMs = current.captureStartedAtMs,
            availability = current.captureAvailability(granted),
            byteLimit = captureByteLimit(),
        )
    }.hot {
        state.value.let {
            LinkCaptureSpec(
                phase = it.capture,
                startedAtMs = it.captureStartedAtMs,
                availability = it.captureAvailability(microphoneGranted.value),
                byteLimit = captureByteLimit(),
            )
        }
    }

    val inspections: Flow<List<ProductPortInspection>> = runtime.inspectionFlow()

    private val talkCommand: ProductComponentEventEmitter<LinkCaptureCommandEvent, Unit>
    private val composerCompose: ProductComponentEventEmitter<LinkComposeEvent, Unit>
    private val activePlaybackCommand: ProductComponentEventEmitter<LinkPlaybackCommandEvent, Unit>
    private val targetSelect: ProductComponentEventEmitter<LinkTargetSelectEvent, Unit>
    private val preferencesToggle: ProductComponentEventEmitter<LinkPreferenceToggleEvent, Unit>
    private val updatesCommand: ProductComponentEventEmitter<LinkUpdateCommandEvent, Unit>
    private val settingsActionOpen: ProductComponentEventEmitter<LinkRouteOpenEvent, Unit>
    private val devHostOpen: ProductComponentEventEmitter<LinkRouteOpenEvent, Unit>

    init {
        // Service outputs first: component inputs may only connect to an
        // upstream that is already mounted, and the hot StateFlow sources
        // publish their current value synchronously inside observe().
        runtime.observe(
            NavigationActivePageOutput,
            navigation.route,
        )
        runtime.observe(
            CaptureStatusOutput,
            combine(state, microphoneGranted) { current, granted ->
                current.toCapturePresentation(granted, captureByteCount())
            }.hot { state.value.toCapturePresentation(microphoneGranted.value, captureByteCount()) },
        )
        runtime.observe(CaptureCapturedOutput, capturedTurns)
        runtime.observe(
            ConversationStatusOutput,
            state.map { it.toConversationPresentation() }.hot { state.value.toConversationPresentation() },
        )
        runtime.observe(
            PlaybackStatusOutput,
            state.map { it.toPlaybackPresentation() }.hot { state.value.toPlaybackPresentation() },
        )
        runtime.observe(
            TargetDirectoryOutput,
            state.map { it.toTargetPresentation(targetKindOf) }
                .hot { state.value.toTargetPresentation(targetKindOf) },
        )
        runtime.observe(
            SessionStatusOutput,
            state.map { it.toSessionPresentation(publicLinkActive()) }
                .hot { state.value.toSessionPresentation(publicLinkActive()) },
        )
        runtime.observe(
            HistoryStatusOutput,
            state.map { it.toHistoryPresentation() }.hot { state.value.toHistoryPresentation() },
        )
        runtime.observe(
            PreferencesStatusOutput,
            combine(state, speakReplies) { current, replies ->
                current.toPreferencesPresentation(replies)
            }.hot { state.value.toPreferencesPresentation(speakReplies.value) },
        )
        runtime.observe(
            UpdatesStatusOutput,
            updateState.map { it.toUpdatePresentation() }.hot { updateState.value.toUpdatePresentation() },
        )
        runtime.observe(
            RecoveryStatusOutput,
            state.map { it.toRecoveryPresentation() }.hot { state.value.toRecoveryPresentation() },
        )

        runtime.observe(
            CapturePresentationModelOutput,
            runtime.connected(CapturePresentationSourceInput, processScope),
        )
        runtime.observe(
            ConversationPresentationModelOutput,
            runtime.connected(ConversationPresentationSourceInput, processScope),
        )
        runtime.observe(
            PlaybackPresentationModelOutput,
            runtime.connected(PlaybackPresentationSourceInput, processScope),
        )
        runtime.observe(
            TargetPresentationModelOutput,
            runtime.connected(TargetPresentationSourceInput, processScope),
        )
        runtime.observe(
            SessionPresentationModelOutput,
            runtime.connected(SessionPresentationSourceInput, processScope),
        )
        runtime.observe(
            HistoryPresentationModelOutput,
            runtime.connected(HistoryPresentationSourceInput, processScope),
        )
        runtime.observe(
            PreferencesPresentationModelOutput,
            runtime.connected(PreferencesPresentationSourceInput, processScope),
        )
        runtime.observe(
            UpdatesPresentationModelOutput,
            runtime.connected(UpdatesPresentationSourceInput, processScope),
        )
        runtime.observe(
            RecoveryPresentationModelOutput,
            runtime.connected(RecoveryPresentationSourceInput, processScope),
        )

        mountStateAuthority(
            GeneratedCapturePhaseAuthority.inputPort<LinkCapturePresentation>(),
            GeneratedCapturePhaseAuthority.outputPort,
            GeneratedCapturePhaseAuthority.componentInputs,
            { it.phase.wireId() },
            GeneratedCapturePhaseAuthority::require,
        )
        mountStateAuthority(
            GeneratedConversationDeliveryPhaseAuthority.inputPort<LinkConversationPresentation>(),
            GeneratedConversationDeliveryPhaseAuthority.outputPort,
            GeneratedConversationDeliveryPhaseAuthority.componentInputs,
            { it.deliveryPhase.wireId() },
            GeneratedConversationDeliveryPhaseAuthority::require,
        )
        mountStateAuthority(
            GeneratedConversationReplyPhaseAuthority.inputPort<LinkConversationPresentation>(),
            GeneratedConversationReplyPhaseAuthority.outputPort,
            GeneratedConversationReplyPhaseAuthority.componentInputs,
            { it.replyPhase.wireId() },
            GeneratedConversationReplyPhaseAuthority::require,
        )
        mountStateAuthority(
            GeneratedPlaybackPhaseAuthority.inputPort<LinkPlaybackPresentation>(),
            GeneratedPlaybackPhaseAuthority.outputPort,
            GeneratedPlaybackPhaseAuthority.componentInputs,
            { it.phase.wireId() },
            GeneratedPlaybackPhaseAuthority::require,
        )
        mountStateAuthority(
            GeneratedTargetKindAuthority.inputPort<LinkTargetPresentation>(),
            GeneratedTargetKindAuthority.outputPort,
            GeneratedTargetKindAuthority.componentInputs,
            { it.kind.wireId() },
            GeneratedTargetKindAuthority::require,
        )
        mountStateAuthority(
            GeneratedSessionConnectionStateAuthority.inputPort<LinkSessionPresentation>(),
            GeneratedSessionConnectionStateAuthority.outputPort,
            GeneratedSessionConnectionStateAuthority.componentInputs,
            { it.connection.wireId() },
            GeneratedSessionConnectionStateAuthority::require,
        )
        mountStateAuthority(
            GeneratedUpdatesPhaseAuthority.inputPort<LinkUpdatePresentation>(),
            GeneratedUpdatesPhaseAuthority.outputPort,
            GeneratedUpdatesPhaseAuthority.componentInputs,
            { it.phase.wireId() },
            GeneratedUpdatesPhaseAuthority::require,
        )
        mountStateAuthority(
            GeneratedRecoveryPhaseAuthority.inputPort<LinkRecoveryPresentation>(),
            GeneratedRecoveryPhaseAuthority.outputPort,
            GeneratedRecoveryPhaseAuthority.componentInputs,
            { it.phase.wireId() },
            GeneratedRecoveryPhaseAuthority::require,
        )

        // The one service-internal edge: a captured turn is delivered to the
        // conversation service through its generated binding, never directly.
        runtime.connected(ConversationTurnInput, processScope) { turn -> sinks.capturedTurn(turn) }

        runtime.bindInput(NavigationOpenSettingsInput) { event -> navigation.open(event.target) }
        runtime.bindInput(NavigationOpenDevHostInput) { event -> navigation.open(event.target) }
        runtime.bindInput(CaptureCommandInput) { event -> sinks.captureCommand(event) }
        runtime.bindInput(ConversationComposeInput) { event -> sinks.compose(event) }
        runtime.bindInput(PlaybackCommandInput) { event -> sinks.playbackCommand(event) }
        runtime.bindInput(TargetSelectInput) { event -> sinks.targetSelect(event) }
        runtime.bindInput(PreferencesToggleInput) { event -> sinks.preferenceToggle(event) }
        runtime.bindInput(UpdatesCommandInput) { event -> sinks.updateCommand(event) }

        target = runtime.connected(TargetModelInput, processScope)
        capture = runtime.connected(TalkModelInput, processScope)
        latest = runtime.connected(LatestModelInput, processScope)
        composerModel = runtime.connected(ComposerModelInput, processScope)
        activePlayback = runtime.connected(ActivePlaybackModelInput, processScope)
        connection = runtime.connected(ConnectionModelInput, processScope)
        publicLink = runtime.connected(PublicLinkModelInput, processScope)
        preferences = runtime.connected(PreferencesModelInput, processScope)
        localHistory = runtime.connected(LocalHistoryModelInput, processScope)
        updates = runtime.connected(UpdatesModelInput, processScope)
        recovery = runtime.connected(RecoveryModelInput, processScope)
        activePage = runtime.connected(PageHostActivePageInput, processScope)

        talkCommand = runtime.componentEvent(TalkCommandEvent, processScope)
        composerCompose = runtime.componentEvent(ComposerComposeEvent, processScope)
        activePlaybackCommand = runtime.componentEvent(ActivePlaybackCommandEvent, processScope)
        targetSelect = runtime.componentEvent(TargetSelectEvent, processScope)
        preferencesToggle = runtime.componentEvent(PreferencesToggleEvent, processScope)
        updatesCommand = runtime.componentEvent(UpdatesCommandEvent, processScope)
        settingsActionOpen = runtime.componentEvent(SettingsActionOpenEvent, processScope)
        devHostOpen = runtime.componentEvent(DevHostOpenEvent, processScope)

        runtime.requireNodeOutputTotality()
        runtime.requireComponentPortTotality()
        runtime.requireNodeInputTotality()
    }

    fun beginCapture(): Boolean {
        onTalkCommand(LinkCaptureCommandEvent(CaptureOperation.BEGIN))
        return state.value.capture == CapturePhase.LISTENING
    }

    fun releaseCapture() = onTalkCommand(LinkCaptureCommandEvent(CaptureOperation.RELEASE))

    fun cancelCapture() = onTalkCommand(LinkCaptureCommandEvent(CaptureOperation.CANCEL))

    fun onTalkCommand(event: LinkCaptureCommandEvent) {
        talkCommand.emit(event)
    }

    fun onComposerCompose(event: LinkComposeEvent) {
        composerCompose.emit(event)
    }

    fun onActivePlaybackCommand(event: LinkPlaybackCommandEvent) {
        activePlaybackCommand.emit(event)
    }

    fun onTargetSelect(event: LinkTargetSelectEvent) {
        targetSelect.emit(event)
    }

    fun onPreferencesToggle(event: LinkPreferenceToggleEvent) {
        preferencesToggle.emit(event)
    }

    fun onUpdatesCommand(event: LinkUpdateCommandEvent) {
        updatesCommand.emit(event)
    }

    fun onSettingsActionOpen(event: LinkRouteOpenEvent) {
        settingsActionOpen.emit(event)
    }

    fun onDevHostOpen(event: LinkRouteOpenEvent) {
        devHostOpen.emit(event)
    }

    open fun close() {
        processScope.cancel()
    }

    private fun <T> Flow<T>.hot(initial: () -> T): StateFlow<T> =
        distinctUntilChanged().stateIn(processScope, SharingStarted.Eagerly, initial())

    private fun <Source : Any, Presentation : Any> mountStateAuthority(
        input: ProductDataInput<Source>,
        output: ProductOutputPort<Presentation>,
        componentInputs: List<ProductComponentInput<Presentation>>,
        stateId: (Source) -> String,
        presentation: (String) -> Presentation,
    ) {
        val source = runtime.connected(input, processScope)
        runtime.observe(
            output,
            source.map { presentation(stateId(it)) }
                .hot { presentation(stateId(source.value)) },
        )
        componentInputs.forEach { runtime.connected(it, processScope) }
    }

    private fun Enum<*>.wireId(): String = name.lowercase().replace('_', '-')
}
