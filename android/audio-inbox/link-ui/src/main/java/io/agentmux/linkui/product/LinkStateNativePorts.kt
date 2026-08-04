package io.agentmux.linkui.product

import com.adelost.releasekit.UpdateState
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.LinkHistoryPolicy
import io.agentmux.linkcore.LinkPreferenceKey
import io.agentmux.linkcore.LinkRecoveryPhase
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTargetKind
import io.agentmux.linkcore.LinkUpdateOperation
import io.agentmux.linkcore.LinkUpdatePhase
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkui.product.generated.HistoryServicePort
import io.agentmux.linkui.product.generated.LinkConnectionState
import io.agentmux.linkui.product.generated.LinkConversationState
import io.agentmux.linkui.product.generated.LinkDeliveryPhase
import io.agentmux.linkui.product.generated.LinkHistoryState
import io.agentmux.linkui.product.generated.LinkPlaybackCommand
import io.agentmux.linkui.product.generated.LinkPlaybackPhase
import io.agentmux.linkui.product.generated.LinkPlaybackState
import io.agentmux.linkui.product.generated.LinkPreferenceToggle
import io.agentmux.linkui.product.generated.LinkPreferencesState
import io.agentmux.linkui.product.generated.LinkRecoveryPhase as GeneratedLinkRecoveryPhase
import io.agentmux.linkui.product.generated.LinkRecoveryState
import io.agentmux.linkui.product.generated.LinkReplyPhase
import io.agentmux.linkui.product.generated.LinkRoute
import io.agentmux.linkui.product.generated.LinkRouteCommand
import io.agentmux.linkui.product.generated.LinkRouteState
import io.agentmux.linkui.product.generated.LinkSessionState
import io.agentmux.linkui.product.generated.LinkTargetKind as GeneratedLinkTargetKind
import io.agentmux.linkui.product.generated.LinkTargetSelect
import io.agentmux.linkui.product.generated.LinkTargetState
import io.agentmux.linkui.product.generated.LinkUpdateCommand
import io.agentmux.linkui.product.generated.LinkUpdatePhase as GeneratedLinkUpdatePhase
import io.agentmux.linkui.product.generated.LinkUpdateState
import io.agentmux.linkui.product.generated.NavigationServicePort
import io.agentmux.linkui.product.generated.PlaybackServicePort
import io.agentmux.linkui.product.generated.PreferencesServicePort
import io.agentmux.linkui.product.generated.RecoveryServicePort
import io.agentmux.linkui.product.generated.SessionServicePort
import io.agentmux.linkui.product.generated.TargetServicePort
import io.agentmux.linkui.product.generated.UpdatesServicePort

class LinkNavigationNativePort(
    private val current: () -> LinkRoute,
    private val navigate: (LinkRoute) -> Unit,
) : NavigationServicePort {
    override fun open(value: LinkRouteCommand) = navigate(value.route)

    override fun destination(): LinkRouteState = LinkRouteState(current())
}

class LinkStatePlaybackServicePort(
    private val state: () -> LinkState,
    private val commandHandler: (LinkPlaybackCommand) -> Unit,
) : PlaybackServicePort {
    override fun command(value: LinkPlaybackCommand) = commandHandler(value)

    override fun status(): LinkPlaybackState {
        val current = state()
        val turn = current.activePlaybackTurnId?.let { id ->
            current.turns.firstOrNull { it.turnId == id }
        } ?: current.turns.lastOrNull()
        return LinkPlaybackState(
            turnId = turn?.turnId,
            phase = LinkPlaybackPhase.valueOf((turn?.playbackPhase ?: PlaybackPhase.IDLE).name),
            positionMs = turn?.playbackPositionMs ?: 0L,
            durationMs = turn?.playbackDurationMs ?: 0L,
        )
    }
}

fun LinkState.conversationState(): LinkConversationState {
    val turn = turns.lastOrNull()
    return LinkConversationState(
        turnId = turn?.turnId,
        deliveryPhase = turn?.deliveryPhase?.let { LinkDeliveryPhase.valueOf(it.name) },
        replyPhase = turn?.replyPhase?.let { LinkReplyPhase.valueOf(it.name) },
        offline = connection != ConnectionState.CONNECTED,
        idempotencyKey = turn?.turnId,
    )
}

class LinkStateTargetServicePort(
    private val state: () -> LinkState,
    private val kindOf: (String) -> LinkTargetKind?,
    private val select: (String) -> Unit,
) : TargetServicePort {
    override fun select(value: LinkTargetSelect) = select(value.targetId)

    override fun directory(): LinkTargetState {
        val current = state()
        val available = current.targets.filter { it.available }
        val selected = available.firstOrNull { it.id == current.selectedTargetId }
            ?: available.firstOrNull()
        return LinkTargetState(
            selectedTargetId = selected?.id,
            kind = selected?.let { kindOf(it.id) }
                ?.let { GeneratedLinkTargetKind.valueOf(it.name) },
            availableCount = available.size.toLong(),
        )
    }
}

class LinkStateSessionServicePort(
    private val state: () -> LinkState,
    private val publicLinkActive: () -> Boolean,
) : SessionServicePort {
    override fun status(): LinkSessionState {
        val current = state()
        return LinkSessionState(
            connection = LinkConnectionState.valueOf(current.connection.name),
            connectionDetail = current.connectionDetail.takeIf { it.isNotBlank() },
            publicLinkActive = publicLinkActive(),
        )
    }
}

class LinkStateHistoryServicePort(
    private val state: () -> LinkState,
) : HistoryServicePort {
    override fun status(): LinkHistoryState = LinkHistoryState(
        retainedTurns = state().turns.size.toLong(),
        maxTurns = LinkHistoryPolicy.MAX_LOCAL_TURNS.toLong(),
    )
}

class LinkStatePreferencesServicePort(
    private val state: () -> LinkState,
    private val speakReplies: () -> Boolean,
    private val setHandsFree: (Boolean) -> Unit,
    private val setSpeakReplies: (Boolean) -> Unit,
) : PreferencesServicePort {
    override fun toggle(value: LinkPreferenceToggle) =
        when (LinkPreferenceKey.valueOf(value.key.name)) {
            LinkPreferenceKey.HANDS_FREE -> setHandsFree(value.enabled)
            LinkPreferenceKey.SPEAK_REPLIES -> setSpeakReplies(value.enabled)
        }

    override fun status(): LinkPreferencesState = LinkPreferencesState(
        handsFree = state().handsFree,
        speakReplies = speakReplies(),
    )
}

class LinkUpdateServicePort(
    private val updateState: () -> UpdateState,
    private val check: () -> Unit,
    private val retry: () -> Unit,
    private val install: () -> Unit,
) : UpdatesServicePort {
    override fun command(value: LinkUpdateCommand) =
        when (LinkUpdateOperation.valueOf(value.operation.name)) {
            LinkUpdateOperation.CHECK -> check()
            LinkUpdateOperation.RETRY -> retry()
            LinkUpdateOperation.INSTALL -> install()
        }

    override fun status(): LinkUpdateState =
        LinkUpdateState(GeneratedLinkUpdatePhase.valueOf(updateState().wirePhase().name))
}

/** The ONE ReleaseKit-to-product phase mapping; exhaustive by compiler. */
fun UpdateState.wirePhase(): LinkUpdatePhase = when (this) {
    is UpdateState.Idle -> LinkUpdatePhase.IDLE
    is UpdateState.Checking -> LinkUpdatePhase.CHECKING
    is UpdateState.UpToDate -> LinkUpdatePhase.UP_TO_DATE
    is UpdateState.Unavailable -> LinkUpdatePhase.UNAVAILABLE
    is UpdateState.Available -> LinkUpdatePhase.AVAILABLE
    is UpdateState.Downloading -> LinkUpdatePhase.DOWNLOADING
    is UpdateState.ReadyToInstall -> LinkUpdatePhase.READY_TO_INSTALL
    is UpdateState.Installing -> LinkUpdatePhase.INSTALLING
    is UpdateState.InstallFailed -> LinkUpdatePhase.INSTALL_FAILED
    is UpdateState.Failed -> LinkUpdatePhase.FAILED
}

class LinkStateRecoveryServicePort(
    private val state: () -> LinkState,
) : RecoveryServicePort {
    override fun status(): LinkRecoveryState {
        val error = state().recoveryError
        val phase = if (error.isBlank()) LinkRecoveryPhase.CLEAN else LinkRecoveryPhase.QUARANTINED
        return LinkRecoveryState(
            phase = GeneratedLinkRecoveryPhase.valueOf(phase.name),
            detail = error.takeIf { it.isNotBlank() },
        )
    }
}
