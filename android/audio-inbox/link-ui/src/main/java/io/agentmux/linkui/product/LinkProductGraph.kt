package io.agentmux.linkui.product

import com.adelost.releasekit.UpdateState
import com.adelost.ringkit.ui.CircleHostPreviewPort
import io.agentmux.linkcore.CaptureOperation
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTargetKind
import io.agentmux.linkui.product.generated.GeneratedLinkCapturePhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkConnectionStateAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkDeliveryPhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkPlaybackPhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkRecoveryPhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkReplyPhaseAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkTargetKindAuthority
import io.agentmux.linkui.product.generated.GeneratedLinkUpdatePhaseAuthority
import io.agentmux.linkui.product.generated.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.isActive

/** The host-supplied native sinks behind the generated effect-owning service inputs. */
class LinkProductSinks(
    val captureCommand: (LinkCaptureCommandEvent) -> Unit,
    val capturedTurn: (LinkCapturedTurn) -> Unit,
    val compose: (LinkComposeEvent) -> Unit,
    val editComposer: (LinkComposerEditEvent) -> Unit,
    val playbackCommand: (LinkPlaybackCommandEvent) -> Unit,
    val targetSelect: (LinkTargetSelectEvent) -> Unit,
    val preferenceToggle: (LinkPreferenceToggleEvent) -> Unit,
    val updateCommand: (LinkUpdateCommandEvent) -> Unit,
    val publicLinkCommand: (LinkPublicLinkCommandEvent) -> Unit,
    val openAttachment: (LinkOpenAttachmentEvent) -> Unit,
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
    captureLevel: () -> Float,
    composerDraft: Flow<String>,
    composerDraftValue: () -> String,
    currentVersionName: String,
    devPreviewPort: CircleHostPreviewPort?,
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

    val targetRenderInputs: StateFlow<GeneratedTargetRenderInputs>
    val talkRenderInputs: StateFlow<GeneratedTalkRenderInputs>
    val latestRenderInputs: StateFlow<GeneratedLatestRenderInputs>
    val composerRenderInputs: StateFlow<GeneratedComposerRenderInputs>
    val activePlaybackRenderInputs: StateFlow<GeneratedActivePlaybackRenderInputs>
    val connectionRenderInputs: StateFlow<GeneratedConnectionRenderInputs>
    val publicLinkRenderInputs: StateFlow<GeneratedPublicLinkRenderInputs>
    val preferencesRenderInputs: StateFlow<GeneratedPreferencesRenderInputs>
    val localHistoryRenderInputs: StateFlow<GeneratedLocalHistoryRenderInputs>
    val updatesRenderInputs: StateFlow<GeneratedUpdatesRenderInputs>
    val recoveryRenderInputs: StateFlow<GeneratedRecoveryRenderInputs>
    val devPreviewRenderInputs: StateFlow<GeneratedDevPreviewRenderInputs>

    lateinit var targetRenderEmitter: GeneratedTargetRenderEmitter
        private set
    lateinit var talkRenderEmitter: GeneratedTalkRenderEmitter
        private set
    lateinit var latestRenderEmitter: GeneratedLatestRenderEmitter
        private set
    lateinit var composerRenderEmitter: GeneratedComposerRenderEmitter
        private set
    lateinit var activePlaybackRenderEmitter: GeneratedActivePlaybackRenderEmitter
        private set
    lateinit var publicLinkRenderEmitter: GeneratedPublicLinkRenderEmitter
        private set
    lateinit var preferencesRenderEmitter: GeneratedPreferencesRenderEmitter
        private set
    lateinit var updatesRenderEmitter: GeneratedUpdatesRenderEmitter
        private set
    lateinit var devPreviewRenderEmitter: GeneratedDevPreviewRenderEmitter
        private set

    val inspections: Flow<List<ProductPortInspection>> = runtime.inspectionFlow()

    private val talkCommand: ProductComponentEventEmitter<LinkCaptureCommandEvent, Unit>
    private val composerCompose: ProductComponentEventEmitter<LinkComposeEvent, Unit>
    private val composerEdit: ProductComponentEventEmitter<LinkComposerEditEvent, Unit>
    private val activePlaybackCommand: ProductComponentEventEmitter<LinkPlaybackCommandEvent, Unit>
    private val latestPlaybackCommand: ProductComponentEventEmitter<LinkPlaybackCommandEvent, Unit>
    private val latestOpenAttachment: ProductComponentEventEmitter<LinkOpenAttachmentEvent, Unit>
    private val targetSelect: ProductComponentEventEmitter<LinkTargetSelectEvent, Unit>
    private val preferencesToggle: ProductComponentEventEmitter<LinkPreferenceToggleEvent, Unit>
    private val updatesCommand: ProductComponentEventEmitter<LinkUpdateCommandEvent, Unit>
    private val publicLinkCommand: ProductComponentEventEmitter<LinkPublicLinkCommandEvent, Unit>
    private val settingsActionOpen: ProductComponentEventEmitter<LinkRouteOpenEvent, Unit>
    private val devHostOpen: ProductComponentEventEmitter<LinkRouteOpenEvent, Unit>
    private val devPreviewBack: ProductComponentEventEmitter<LinkNavigationBackEvent, Unit>

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
            combine(state, microphoneGranted, measurementTicks()) { current, granted, _ ->
                current.toCapturePresentation(
                    granted, captureByteCount(), captureByteLimit(), captureLevel(),
                )
            }.hot {
                state.value.toCapturePresentation(
                    microphoneGranted.value, captureByteCount(), captureByteLimit(), captureLevel(),
                )
            },
        )
        runtime.observe(CaptureCapturedOutput, capturedTurns)
        runtime.observe(
            ConversationStatusOutput,
            combine(state, composerDraft) { current, draft ->
                current.toConversationPresentation(draft)
            }.hot { state.value.toConversationPresentation(composerDraftValue()) },
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
            updateState.map { it.toUpdatePresentation(currentVersionName) }
                .hot { updateState.value.toUpdatePresentation(currentVersionName) },
        )
        runtime.observe(
            RecoveryStatusOutput,
            state.map { it.toRecoveryPresentation() }.hot { state.value.toRecoveryPresentation() },
        )
        runtime.observe(
            DevPreviewStatusOutput,
            MutableStateFlow(LinkDevPreviewPresentation(devPreviewPort, inspections)),
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
            DevPreviewPresentationModelOutput,
            runtime.connected(DevPreviewPresentationSourceInput, processScope),
        )

        val captureStates = mountStateAuthority(
            GeneratedLinkCapturePhaseAuthority.inputPort<LinkCapturePresentation>(),
            GeneratedLinkCapturePhaseAuthority.outputPort,
            GeneratedLinkCapturePhaseAuthority.componentInputs,
            { it.phase.wireId() },
            GeneratedLinkCapturePhaseAuthority::require,
        )
        val deliveryStates = mountStateAuthority(
            GeneratedLinkDeliveryPhaseAuthority.inputPort<LinkConversationPresentation>(),
            GeneratedLinkDeliveryPhaseAuthority.outputPort,
            GeneratedLinkDeliveryPhaseAuthority.componentInputs,
            { it.deliveryPhase.wireId() },
            GeneratedLinkDeliveryPhaseAuthority::require,
        )
        val replyStates = mountStateAuthority(
            GeneratedLinkReplyPhaseAuthority.inputPort<LinkConversationPresentation>(),
            GeneratedLinkReplyPhaseAuthority.outputPort,
            GeneratedLinkReplyPhaseAuthority.componentInputs,
            { it.replyPhase.wireId() },
            GeneratedLinkReplyPhaseAuthority::require,
        )
        val playbackStates = mountStateAuthority(
            GeneratedLinkPlaybackPhaseAuthority.inputPort<LinkPlaybackPresentation>(),
            GeneratedLinkPlaybackPhaseAuthority.outputPort,
            GeneratedLinkPlaybackPhaseAuthority.componentInputs,
            { it.phase.wireId() },
            GeneratedLinkPlaybackPhaseAuthority::require,
        )
        val targetStates = mountStateAuthority(
            GeneratedLinkTargetKindAuthority.inputPort<LinkTargetPresentation>(),
            GeneratedLinkTargetKindAuthority.outputPort,
            GeneratedLinkTargetKindAuthority.componentInputs,
            { it.kind.wireId() },
            GeneratedLinkTargetKindAuthority::require,
        )
        val connectionStates = mountStateAuthority(
            GeneratedLinkConnectionStateAuthority.inputPort<LinkSessionPresentation>(),
            GeneratedLinkConnectionStateAuthority.outputPort,
            GeneratedLinkConnectionStateAuthority.componentInputs,
            { it.connection.wireId() },
            GeneratedLinkConnectionStateAuthority::require,
        )
        val updateStates = mountStateAuthority(
            GeneratedLinkUpdatePhaseAuthority.inputPort<LinkUpdatePresentation>(),
            GeneratedLinkUpdatePhaseAuthority.outputPort,
            GeneratedLinkUpdatePhaseAuthority.componentInputs,
            { it.phase.wireId() },
            GeneratedLinkUpdatePhaseAuthority::require,
        )
        val recoveryStates = mountStateAuthority(
            GeneratedLinkRecoveryPhaseAuthority.inputPort<LinkRecoveryPresentation>(),
            GeneratedLinkRecoveryPhaseAuthority.outputPort,
            GeneratedLinkRecoveryPhaseAuthority.componentInputs,
            { it.phase.wireId() },
            GeneratedLinkRecoveryPhaseAuthority::require,
        )

        // The one service-internal edge: a captured turn is delivered to the
        // conversation service through its generated binding, never directly.
        runtime.connected(ConversationTurnInput, processScope) { turn -> sinks.capturedTurn(turn) }

        runtime.bindInput(NavigationOpenSettingsInput) { event -> navigation.open(event.target) }
        runtime.bindInput(NavigationOpenDevHostInput) { event -> navigation.open(event.target) }
        runtime.bindInput(NavigationBackInput) { navigation.back() }
        runtime.bindInput(CaptureCommandInput) { event -> sinks.captureCommand(event) }
        runtime.bindInput(ConversationComposeInput) { event -> sinks.compose(event) }
        runtime.bindInput(ConversationEditInput) { event -> sinks.editComposer(event) }
        runtime.bindInput(PlaybackCommandInput) { event -> sinks.playbackCommand(event) }
        runtime.bindInput(PlaybackLatestCommandInput) { event -> sinks.playbackCommand(event) }
        runtime.bindInput(TargetSelectInput) { event -> sinks.targetSelect(event) }
        runtime.bindInput(PreferencesToggleInput) { event -> sinks.preferenceToggle(event) }
        runtime.bindInput(UpdatesCommandInput) { event -> sinks.updateCommand(event) }
        runtime.bindInput(SessionCommandInput) { event -> sinks.publicLinkCommand(event) }
        runtime.bindInput(HostOpenAttachmentInput) { event -> sinks.openAttachment(event) }

        target = runtime.connected(TargetModelInput, processScope)
        runtime.connected(TargetSessionInput, processScope)
        runtime.connected(TargetRecoveryInput, processScope)
        capture = runtime.connected(TalkModelInput, processScope)
        latest = runtime.connected(LatestModelInput, processScope)
        runtime.connected(LatestPlaybackInput, processScope)
        composerModel = runtime.connected(ComposerModelInput, processScope)
        runtime.connected(ComposerTargetInput, processScope)
        activePlayback = runtime.connected(ActivePlaybackModelInput, processScope)
        connection = runtime.connected(ConnectionModelInput, processScope)
        publicLink = runtime.connected(PublicLinkModelInput, processScope)
        preferences = runtime.connected(PreferencesModelInput, processScope)
        localHistory = runtime.connected(LocalHistoryModelInput, processScope)
        updates = runtime.connected(UpdatesModelInput, processScope)
        recovery = runtime.connected(RecoveryModelInput, processScope)
        activePage = runtime.connected(PageHostActivePageInput, processScope)
        val devPreviewModel = runtime.connected(DevPreviewModelInput, processScope)

        fun <T : Any> Map<String, StateFlow<T>>.component(ref: String): StateFlow<T> =
            requireNotNull(this[ref]) { "Missing actual component input $ref" }

        val targetCore = combine(
            target,
            targetStates.component("target.targetState"),
            connection,
            connectionStates.component("target.connectionState"),
            recovery,
        ) { model, targetState, session, connectionState, recoveryModel ->
            GeneratedTargetRenderInputs(
                model, targetState, session, connectionState, recoveryModel,
                recoveryStates.component("target.recoveryState").value,
            )
        }.hot {
            GeneratedTargetRenderInputs(
                target.value,
                targetStates.component("target.targetState").value,
                connection.value,
                connectionStates.component("target.connectionState").value,
                recovery.value,
                recoveryStates.component("target.recoveryState").value,
            )
        }
        targetRenderInputs = combine(
            targetCore,
            recoveryStates.component("target.recoveryState"),
        ) { inputs, state -> inputs.copy(recoveryState = state) }.hot { targetCore.value }
        talkRenderInputs = combine(
            capture, captureStates.component("talk.captureState"),
            ::GeneratedTalkRenderInputs,
        ).hot {
            GeneratedTalkRenderInputs(capture.value, captureStates.component("talk.captureState").value)
        }
        latestRenderInputs = combine(
            latest,
            deliveryStates.component("latest.deliveryState"),
            replyStates.component("latest.replyState"),
            activePlayback,
            playbackStates.component("latest.playbackState"),
            ::GeneratedLatestRenderInputs,
        ).hot {
            GeneratedLatestRenderInputs(
                latest.value,
                deliveryStates.component("latest.deliveryState").value,
                replyStates.component("latest.replyState").value,
                activePlayback.value,
                playbackStates.component("latest.playbackState").value,
            )
        }
        composerRenderInputs = combine(
            composerModel,
            deliveryStates.component("composer.deliveryState"),
            replyStates.component("composer.replyState"),
            target,
            targetStates.component("composer.targetState"),
            ::GeneratedComposerRenderInputs,
        ).hot {
            GeneratedComposerRenderInputs(
                composerModel.value,
                deliveryStates.component("composer.deliveryState").value,
                replyStates.component("composer.replyState").value,
                target.value,
                targetStates.component("composer.targetState").value,
            )
        }
        activePlaybackRenderInputs = combine(
            activePlayback,
            playbackStates.component("active-playback.playbackState"),
            ::GeneratedActivePlaybackRenderInputs,
        ).hot {
            GeneratedActivePlaybackRenderInputs(
                activePlayback.value,
                playbackStates.component("active-playback.playbackState").value,
            )
        }
        connectionRenderInputs = combine(
            connection,
            connectionStates.component("connection.connectionState"),
            ::GeneratedConnectionRenderInputs,
        ).hot {
            GeneratedConnectionRenderInputs(
                connection.value, connectionStates.component("connection.connectionState").value,
            )
        }
        publicLinkRenderInputs = combine(
            publicLink,
            connectionStates.component("public-link.connectionState"),
            ::GeneratedPublicLinkRenderInputs,
        ).hot {
            GeneratedPublicLinkRenderInputs(
                publicLink.value, connectionStates.component("public-link.connectionState").value,
            )
        }
        preferencesRenderInputs = preferences.map(::GeneratedPreferencesRenderInputs)
            .hot { GeneratedPreferencesRenderInputs(preferences.value) }
        localHistoryRenderInputs = localHistory.map(::GeneratedLocalHistoryRenderInputs)
            .hot { GeneratedLocalHistoryRenderInputs(localHistory.value) }
        updatesRenderInputs = combine(
            updates,
            updateStates.component("updates.updateState"),
            ::GeneratedUpdatesRenderInputs,
        ).hot {
            GeneratedUpdatesRenderInputs(updates.value, updateStates.component("updates.updateState").value)
        }
        recoveryRenderInputs = combine(
            recovery,
            recoveryStates.component("recovery.recoveryState"),
            ::GeneratedRecoveryRenderInputs,
        ).hot {
            GeneratedRecoveryRenderInputs(recovery.value, recoveryStates.component("recovery.recoveryState").value)
        }
        devPreviewRenderInputs = devPreviewModel.map(::GeneratedDevPreviewRenderInputs)
            .hot { GeneratedDevPreviewRenderInputs(devPreviewModel.value) }

        talkCommand = runtime.componentEvent(TalkCommandEvent, processScope)
        composerCompose = runtime.componentEvent(ComposerComposeEvent, processScope)
        composerEdit = runtime.componentEvent(ComposerEditEvent, processScope)
        activePlaybackCommand = runtime.componentEvent(ActivePlaybackCommandEvent, processScope)
        latestPlaybackCommand = runtime.componentEvent(LatestPlaybackCommandEvent, processScope)
        latestOpenAttachment = runtime.componentEvent(LatestOpenAttachmentEvent, processScope)
        targetSelect = runtime.componentEvent(TargetSelectEvent, processScope)
        preferencesToggle = runtime.componentEvent(PreferencesToggleEvent, processScope)
        updatesCommand = runtime.componentEvent(UpdatesCommandEvent, processScope)
        publicLinkCommand = runtime.componentEvent(PublicLinkCommandEvent, processScope)
        settingsActionOpen = runtime.componentEvent(SettingsActionOpenEvent, processScope)
        devHostOpen = runtime.componentEvent(DevHostOpenEvent, processScope)
        devPreviewBack = runtime.componentEvent(DevPreviewBackEvent, processScope)

        targetRenderEmitter = GeneratedTargetRenderEmitter(targetSelect::emit)
        talkRenderEmitter = GeneratedTalkRenderEmitter(talkCommand::emit)
        latestRenderEmitter = object : GeneratedLatestRenderEmitter {
            override fun playbackCommand(event: LinkPlaybackCommandEvent) = latestPlaybackCommand.emit(event)
            override fun openAttachment(event: LinkOpenAttachmentEvent) = latestOpenAttachment.emit(event)
        }
        composerRenderEmitter = object : GeneratedComposerRenderEmitter {
            override fun compose(event: LinkComposeEvent) = composerCompose.emit(event)
            override fun edit(event: LinkComposerEditEvent) = composerEdit.emit(event)
        }
        activePlaybackRenderEmitter = GeneratedActivePlaybackRenderEmitter(activePlaybackCommand::emit)
        publicLinkRenderEmitter = GeneratedPublicLinkRenderEmitter(publicLinkCommand::emit)
        preferencesRenderEmitter = GeneratedPreferencesRenderEmitter(preferencesToggle::emit)
        updatesRenderEmitter = GeneratedUpdatesRenderEmitter(updatesCommand::emit)
        devPreviewRenderEmitter = GeneratedDevPreviewRenderEmitter(devPreviewBack::emit)

        runtime.requireNodeOutputTotality()
        runtime.requireComponentPortTotality()
        runtime.requireNodeInputTotality()
    }

    fun onSettingsActionOpen(event: LinkRouteOpenEvent) {
        settingsActionOpen.emit(event)
    }

    fun onDevHostOpen(event: LinkRouteOpenEvent) {
        devHostOpen.emit(event)
    }

    /** Actual generated input endpoint used by host renderer registrations. */
    fun readRendererInput(id: GeneratedLinkRendererInputId): Any = when (id) {
        GeneratedLinkRendererInputId.PAGE_HOST_ACTIVEPAGE -> activePage.value
        GeneratedLinkRendererInputId.TARGET_MODEL -> targetRenderInputs.value.model
        GeneratedLinkRendererInputId.TARGET_TARGETSTATE -> targetRenderInputs.value.targetState
        GeneratedLinkRendererInputId.TARGET_SESSION -> targetRenderInputs.value.session
        GeneratedLinkRendererInputId.TARGET_CONNECTIONSTATE -> targetRenderInputs.value.connectionState
        GeneratedLinkRendererInputId.TARGET_RECOVERY -> targetRenderInputs.value.recovery
        GeneratedLinkRendererInputId.TARGET_RECOVERYSTATE -> targetRenderInputs.value.recoveryState
        GeneratedLinkRendererInputId.TALK_MODEL -> talkRenderInputs.value.model
        GeneratedLinkRendererInputId.TALK_CAPTURESTATE -> talkRenderInputs.value.captureState
        GeneratedLinkRendererInputId.LATEST_MODEL -> latestRenderInputs.value.model
        GeneratedLinkRendererInputId.LATEST_DELIVERYSTATE -> latestRenderInputs.value.deliveryState
        GeneratedLinkRendererInputId.LATEST_REPLYSTATE -> latestRenderInputs.value.replyState
        GeneratedLinkRendererInputId.LATEST_PLAYBACK -> latestRenderInputs.value.playback
        GeneratedLinkRendererInputId.LATEST_PLAYBACKSTATE -> latestRenderInputs.value.playbackState
        GeneratedLinkRendererInputId.COMPOSER_MODEL -> composerRenderInputs.value.model
        GeneratedLinkRendererInputId.COMPOSER_DELIVERYSTATE -> composerRenderInputs.value.deliveryState
        GeneratedLinkRendererInputId.COMPOSER_REPLYSTATE -> composerRenderInputs.value.replyState
        GeneratedLinkRendererInputId.COMPOSER_TARGET -> composerRenderInputs.value.target
        GeneratedLinkRendererInputId.COMPOSER_TARGETSTATE -> composerRenderInputs.value.targetState
        GeneratedLinkRendererInputId.ACTIVE_PLAYBACK_MODEL -> activePlaybackRenderInputs.value.model
        GeneratedLinkRendererInputId.ACTIVE_PLAYBACK_PLAYBACKSTATE -> activePlaybackRenderInputs.value.playbackState
        GeneratedLinkRendererInputId.CONNECTION_MODEL -> connectionRenderInputs.value.model
        GeneratedLinkRendererInputId.CONNECTION_CONNECTIONSTATE -> connectionRenderInputs.value.connectionState
        GeneratedLinkRendererInputId.PUBLIC_LINK_MODEL -> publicLinkRenderInputs.value.model
        GeneratedLinkRendererInputId.PUBLIC_LINK_CONNECTIONSTATE -> publicLinkRenderInputs.value.connectionState
        GeneratedLinkRendererInputId.PREFERENCES_MODEL -> preferencesRenderInputs.value.model
        GeneratedLinkRendererInputId.LOCAL_HISTORY_MODEL -> localHistoryRenderInputs.value.model
        GeneratedLinkRendererInputId.UPDATES_MODEL -> updatesRenderInputs.value.model
        GeneratedLinkRendererInputId.UPDATES_UPDATESTATE -> updatesRenderInputs.value.updateState
        GeneratedLinkRendererInputId.RECOVERY_MODEL -> recoveryRenderInputs.value.model
            GeneratedLinkRendererInputId.RECOVERY_RECOVERYSTATE -> recoveryRenderInputs.value.recoveryState
            GeneratedLinkRendererInputId.DEV_PREVIEW_MODEL -> devPreviewRenderInputs.value.model
    }

    /** Actual typed event sink used by host renderer registrations. */
    fun emitRendererEvent(id: GeneratedLinkRendererEventId, payload: Any) {
        when (id) {
            GeneratedLinkRendererEventId.TARGET_SELECT -> targetRenderEmitter.select(payload as LinkTargetSelectEvent)
            GeneratedLinkRendererEventId.TALK_COMMAND -> talkRenderEmitter.command(payload as LinkCaptureCommandEvent)
            GeneratedLinkRendererEventId.LATEST_PLAYBACKCOMMAND -> latestRenderEmitter.playbackCommand(payload as LinkPlaybackCommandEvent)
            GeneratedLinkRendererEventId.LATEST_OPENATTACHMENT -> latestRenderEmitter.openAttachment(payload as LinkOpenAttachmentEvent)
            GeneratedLinkRendererEventId.COMPOSER_COMPOSE -> composerRenderEmitter.compose(payload as LinkComposeEvent)
            GeneratedLinkRendererEventId.COMPOSER_EDIT -> composerRenderEmitter.edit(payload as LinkComposerEditEvent)
            GeneratedLinkRendererEventId.ACTIVE_PLAYBACK_COMMAND -> activePlaybackRenderEmitter.command(payload as LinkPlaybackCommandEvent)
            GeneratedLinkRendererEventId.PUBLIC_LINK_COMMAND -> publicLinkRenderEmitter.command(payload as LinkPublicLinkCommandEvent)
            GeneratedLinkRendererEventId.PREFERENCES_TOGGLE -> preferencesRenderEmitter.toggle(payload as LinkPreferenceToggleEvent)
            GeneratedLinkRendererEventId.UPDATES_COMMAND -> updatesRenderEmitter.command(payload as LinkUpdateCommandEvent)
            GeneratedLinkRendererEventId.SETTINGS_ACTION_OPEN -> onSettingsActionOpen(payload as LinkRouteOpenEvent)
            GeneratedLinkRendererEventId.DEV_HOST_OPEN -> onDevHostOpen(payload as LinkRouteOpenEvent)
            GeneratedLinkRendererEventId.DEV_PREVIEW_BACK -> devPreviewRenderEmitter.back(payload as LinkNavigationBackEvent)
        }
    }

    open fun close() {
        processScope.cancel()
    }

    private fun <T> Flow<T>.hot(initial: () -> T): StateFlow<T> =
        distinctUntilChanged().stateIn(processScope, SharingStarted.Eagerly, initial())

    private fun measurementTicks(): Flow<Unit> = flow {
        while (currentCoroutineContext().isActive) {
            emit(Unit)
            delay(100L)
        }
    }

    private fun <Source : Any, Presentation : Any> mountStateAuthority(
        input: ProductDataInput<Source>,
        output: ProductOutputPort<Presentation>,
        componentInputs: List<ProductComponentInput<Presentation>>,
        stateId: (Source) -> String,
        presentation: (String) -> Presentation,
    ): Map<String, StateFlow<Presentation>> {
        val source = runtime.connected(input, processScope)
        runtime.observe(
            output,
            source.map { presentation(stateId(it)) }
                .hot { presentation(stateId(source.value)) },
        )
        return componentInputs.associate { input ->
            input.id.value to runtime.connected(input, processScope)
        }
    }

    private fun Enum<*>.wireId(): String = name.lowercase().replace('_', '-')
}
