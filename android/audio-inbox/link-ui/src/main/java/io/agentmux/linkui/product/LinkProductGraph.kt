package io.agentmux.linkui.product

import io.agentmux.linkui.product.generated.GeneratedLinkCapturedTurn
import io.agentmux.linkui.product.generated.GeneratedLinkWakeNotificationIconValue
import io.agentmux.linkui.product.generated.GeneratedLinkComposeTurn
import io.agentmux.linkui.product.generated.GeneratedLinkHistoryClear
import io.agentmux.linkui.product.generated.GeneratedLinkHistoryStatus
import io.agentmux.linkui.product.generated.GeneratedLinkPreferencesStatus
import io.agentmux.linkui.product.generated.GeneratedLinkTargetSelect
import com.adelost.releasekit.UpdateState
import io.agentmux.wakeword.WakePhase
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
import io.agentmux.linkui.product.generated.GeneratedWakePhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedWakePhraseAuthority
import io.agentmux.wakeword.WakeStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

private const val MIN_CAPTURE_NANOS = 500_000_000L

/** The host-supplied native sinks behind the generated effect-owning service inputs. */
class LinkProductSinks(
    val captureCommand: (LinkCaptureCommandEvent) -> Unit,
    val capturedTurn: (GeneratedLinkCapturedTurn) -> Unit,
    val compose: (GeneratedLinkComposeTurn) -> Unit,
    val playbackCommand: (LinkPlaybackCommandEvent) -> Unit,
    val targetSelect: (GeneratedLinkTargetSelect) -> Unit,
    val preferenceToggle: (LinkPreferenceToggleEvent) -> Unit,
    val historyClear: (GeneratedLinkHistoryClear) -> Unit,
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
    wakeWordEnabled: StateFlow<Boolean>,
    wakeStatus: StateFlow<WakeStatus>,
    publicLinkActive: () -> Boolean,
    targetKindOf: (String) -> LinkTargetKind?,
    captureByteCount: () -> Long,
    captureByteLimit: () -> Long?,
    capturedTurns: Flow<GeneratedLinkCapturedTurn>,
    val navigation: LinkNavigationController,
    private val sinks: LinkProductSinks,
    private val monotonicNanos: () -> Long = System::nanoTime,
) {
    private val runtime = LinkProductPortRuntime(processScope)
    private var captureBeganAtNanos: Long? = null

    val target: StateFlow<LinkTargetPresentation>
    val capture: StateFlow<LinkCapturePresentation>
    val latest: StateFlow<LinkConversationPresentation>
    val composerModel: StateFlow<LinkConversationPresentation>
    val activePlayback: StateFlow<LinkPlaybackPresentation>
    val connection: StateFlow<LinkSessionPresentation>
    val publicLink: StateFlow<LinkSessionPresentation>
    val preferences: StateFlow<GeneratedLinkPreferencesStatus>
    val localHistory: StateFlow<GeneratedLinkHistoryStatus>
    val updates: StateFlow<LinkUpdatePresentation>
    val recovery: StateFlow<LinkRecoveryPresentation>
    val wake: StateFlow<LinkWakePresentation>

    /** wake.toggle.model — the main page control's own port onto the same presentation. */
    val wakeToggleModel: StateFlow<LinkWakePresentation>
    val activePage: StateFlow<LinkRoute>

    /** The capture control's host-neutral spec, derived beside the talk model. */
    val captureSpec: StateFlow<LinkCaptureSpec> = run {
        // Hands-free drives the same talk control as holding it, so both kinds of listening look alike.
        val specOf = { current: LinkState, granted: Boolean, wake: WakeStatus ->
            LinkCaptureSpec(
                phase = current.capture,
                startedAtMs = current.captureStartedAtMs,
                availability = current.captureAvailability(granted),
                byteLimit = captureByteLimit(),
                wake = wake,
            )
        }
        combine(state, microphoneGranted, wakeStatus, specOf).hot { specOf(state.value, microphoneGranted.value, wakeStatus.value) }
    }

    val inspections: Flow<List<com.adelost.ringkit.ports.CirclePortInspection>> = runtime.inspectionFlow()

    private val talkCommand: ProductComponentEventEmitter<LinkCaptureCommandEvent, Unit>
    private val composerCompose: ProductComponentEventEmitter<GeneratedLinkComposeTurn, Unit>
    private val activePlaybackCommand: ProductComponentEventEmitter<LinkPlaybackCommandEvent, Unit>
    private val targetSelect: ProductComponentEventEmitter<GeneratedLinkTargetSelect, Unit>
    private val preferencesToggle: ProductComponentEventEmitter<LinkPreferenceToggleEvent, Unit>
    private val localHistoryClear: ProductComponentEventEmitter<GeneratedLinkHistoryClear, Unit>
    private val updatesCommand: ProductComponentEventEmitter<LinkUpdateCommandEvent, Unit>
    private val settingsActionOpen: ProductComponentEventEmitter<LinkRouteOpenEvent, Unit>
    private val wakeToggle: ProductComponentEventEmitter<LinkPreferenceToggleEvent, Unit>
    private val devHostOpen: ProductComponentEventEmitter<LinkRouteOpenEvent, Unit>
    private val wakeDebugOpen: ProductComponentEventEmitter<LinkRouteOpenEvent, Unit>

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
            combine(state, speakReplies, wakeWordEnabled) { current, replies, wakeWord ->
                current.toPreferencesPresentation(replies, wakeWord)
            }.hot { state.value.toPreferencesPresentation(speakReplies.value, wakeWordEnabled.value) },
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
            WakeStatusOutput,
            wakeStatus.map { it.toWakePresentation() }.hot { wakeStatus.value.toWakePresentation() },
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
        runtime.observe(
            WakePresentationModelOutput,
            runtime.connected(WakePresentationSourceInput, processScope),
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
        mountStateAuthority(
            GeneratedWakePhaseAuthority.inputPort<LinkWakePresentation>(),
            GeneratedWakePhaseAuthority.outputPort,
            GeneratedWakePhaseAuthority.componentInputs,
            { it.phase.wireId() },
            GeneratedWakePhaseAuthority::require,
        )
        mountStateAuthority(
            GeneratedWakePhraseAuthority.inputPort<LinkWakePresentation>(),
            GeneratedWakePhraseAuthority.outputPort,
            GeneratedWakePhraseAuthority.componentInputs,
            { it.phrase.id },
            GeneratedWakePhraseAuthority::require,
        )

        // The one service-internal edge: a captured turn is delivered to the
        // conversation service through its generated binding, never directly.
        runtime.connected(ConversationTurnInput, processScope) { turn -> sinks.capturedTurn(turn) }

        runtime.bindInput(NavigationOpenSettingsInput) { event -> navigation.open(event.target) }
        runtime.bindInput(NavigationOpenDevHostInput) { event -> navigation.open(event.target) }
        runtime.bindInput(NavigationOpenWakeDebugInput) { event -> navigation.open(event.target) }
        runtime.bindInput(CaptureCommandInput) { event -> sinks.captureCommand(event) }
        runtime.bindInput(ConversationComposeInput) { event -> sinks.compose(event) }
        runtime.bindInput(PlaybackCommandInput) { event -> sinks.playbackCommand(event) }
        runtime.bindInput(TargetSelectInput) { event -> sinks.targetSelect(event) }
        runtime.bindInput(PreferencesToggleInput) { event -> sinks.preferenceToggle(event) }
        // The main page's control and the Settings list write the same preference through the same sink.
        runtime.bindInput(PreferencesWakeToggleInput) { event -> sinks.preferenceToggle(event) }
        runtime.bindInput(HistoryClearInput) { event -> sinks.historyClear(event) }
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
        wake = runtime.connected(WakeModelInput, processScope)
        wakeToggleModel = runtime.connected(WakeToggleModelInput, processScope)
        activePage = runtime.connected(PageHostActivePageInput, processScope)

        talkCommand = runtime.componentEvent(TalkCommandEvent, processScope)
        composerCompose = runtime.componentEvent(ComposerComposeEvent, processScope)
        activePlaybackCommand = runtime.componentEvent(ActivePlaybackCommandEvent, processScope)
        targetSelect = runtime.componentEvent(TargetSelectEvent, processScope)
        preferencesToggle = runtime.componentEvent(PreferencesToggleEvent, processScope)
        wakeToggle = runtime.componentEvent(WakeToggleEvent, processScope)
        localHistoryClear = runtime.componentEvent(LocalHistoryClearEvent, processScope)
        updatesCommand = runtime.componentEvent(UpdatesCommandEvent, processScope)
        settingsActionOpen = runtime.componentEvent(SettingsActionOpenEvent, processScope)
        devHostOpen = runtime.componentEvent(DevHostOpenEvent, processScope)
        wakeDebugOpen = runtime.componentEvent(WakeDebugOpenEvent, processScope)

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
        when (event.operation) {
            CaptureOperation.BEGIN -> {
                if (captureBeganAtNanos != null) return
                talkCommand.emit(event)
                captureBeganAtNanos = monotonicNanos().takeIf { state.value.capture == CapturePhase.LISTENING }
            }
            CaptureOperation.RELEASE -> {
                val started = captureBeganAtNanos ?: return
                captureBeganAtNanos = null
                val operation = if (monotonicNanos() - started < MIN_CAPTURE_NANOS)
                    CaptureOperation.CANCEL else CaptureOperation.RELEASE
                talkCommand.emit(LinkCaptureCommandEvent(operation))
            }
            CaptureOperation.CANCEL -> {
                captureBeganAtNanos = null
                talkCommand.emit(event)
            }
        }
    }

    fun onComposerCompose(event: GeneratedLinkComposeTurn) {
        composerCompose.emit(event)
    }

    fun onActivePlaybackCommand(event: LinkPlaybackCommandEvent) {
        activePlaybackCommand.emit(event)
    }

    fun onTargetSelect(event: GeneratedLinkTargetSelect) {
        targetSelect.emit(event)
    }

    fun onPreferencesToggle(event: LinkPreferenceToggleEvent) {
        preferencesToggle.emit(event)
    }

    fun onLocalHistoryClear(event: GeneratedLinkHistoryClear) {
        localHistoryClear.emit(event)
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

    fun onWakeToggle(event: LinkPreferenceToggleEvent) {
        wakeToggle.emit(event)
    }

    fun onWakeDebugOpen(event: LinkRouteOpenEvent) {
        wakeDebugOpen.emit(event)
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


}

/** A Kotlin enum constant as the declaration spells it: LOWER_SNAKE becomes lower-dash. */
internal fun Enum<*>.wireId(): String = name.lowercase().replace('_', '-')

/**
 * The one declared word for a wake phase. A control that has room for one word shows this and never a
 * word of its own, so what a wearer reads cannot drift from the phase the loop is in.
 */
fun wakePhaseWord(phase: WakePhase): String = GeneratedWakePhaseAuthority.require(phase.wireId()).word

/** The three glyphs the ongoing notification may wear, as the declaration names them. */
enum class WakeNotificationIcon { WAITING, HEARING, SPEAKING }

/**
 * Which glyph a phase wears, from the declaration. A host maps these three to its own resources; nothing
 * decides the grouping in native code, so the status bar cannot disagree with the phase.
 */
fun wakeNotificationIcon(phase: WakePhase): WakeNotificationIcon =
    when (GeneratedWakePhaseAuthority.require(phase.wireId()).notificationIcon) {
        GeneratedLinkWakeNotificationIconValue.WAITING -> WakeNotificationIcon.WAITING
        GeneratedLinkWakeNotificationIconValue.HEARING -> WakeNotificationIcon.HEARING
        GeneratedLinkWakeNotificationIconValue.SPEAKING -> WakeNotificationIcon.SPEAKING
    }
