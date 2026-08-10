package io.agentmux.linkui.product

import com.adelost.releasekit.UpdateState
import com.adelost.ringkit.ui.CircleHostPreviewPort
import kotlinx.coroutines.flow.Flow
import io.agentmux.linkcore.CaptureOperation
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkHistoryPolicy
import io.agentmux.linkcore.LinkPreferenceKey
import io.agentmux.linkcore.LinkRecoveryPhase
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkcore.LinkTargetKind
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.LinkUpdateOperation
import io.agentmux.linkcore.LinkUpdatePhase
import io.agentmux.linkcore.PlaybackOperation
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.ReplyPhase
import io.agentmux.linkui.LinkCaptureAvailability
import io.agentmux.linkui.resolveLinkCaptureAvailability
import io.agentmux.linkui.product.generated.GeneratedLinkPageId

/** Native source compatibility over ProductSpec's generated closed PageId. */
typealias LinkRoute = GeneratedLinkPageId

/** capture.presentation.model — the talk component's model. */
data class LinkCapturePresentation(
    val phase: CapturePhase,
    val available: Boolean,
    val unavailableReason: String?,
    val recoveryActionAvailable: Boolean,
    val startedAtMs: Long?,
    val byteCount: Long,
    val byteLimit: Long?,
    val level: Float,
    val sampledAtMs: Long,
)

/** capture.service.captured — the service-internal edge into conversation.service.turn. */
data class LinkCapturedTurn(
    val turnId: String,
    val targetId: String,
    val payloadRef: String,
    val idempotencyKey: String,
    val createdAtMs: Long,
)

/** conversation.presentation.model — the latest-turn and composer components' model. */
data class LinkConversationPresentation(
    val turnId: String?,
    val deliveryPhase: DeliveryPhase,
    val replyPhase: ReplyPhase,
    val offline: Boolean,
    val idempotencyKey: String?,
    val draftText: String,
    val turns: List<LinkTurn>,
)

/** playback.presentation.model — the active-playback component's model. */
data class LinkPlaybackPresentation(
    val turnId: String?,
    val phase: PlaybackPhase,
    val positionMs: Long,
    val durationMs: Long,
    val turn: LinkTurn?,
)

/** target.presentation.model — the target component's model (the picker's available targets). */
data class LinkTargetPresentation(
    val selectedTargetId: String?,
    val kind: LinkTargetKind,
    val availableCount: Int,
    val targets: List<LinkTarget>,
)

/** session.presentation.model — the connection and public-link components' model. */
data class LinkSessionPresentation(
    val connection: ConnectionState,
    val connectionDetail: String?,
    val publicLinkActive: Boolean,
)

/** history.presentation.model — the local-history component's model. */
data class LinkHistoryPresentation(
    val retainedTurns: Int,
    val maxTurns: Int,
)

/** preferences.presentation.model — the preferences component's model. */
data class LinkPreferencesPresentation(
    val handsFree: Boolean,
    val speakReplies: Boolean,
)

/** updates.presentation.model — the updates component's model. */
data class LinkUpdatePresentation(
    val phase: LinkUpdatePhase,
    val update: UpdateState,
    val currentVersionName: String,
)

/** recovery.presentation.model — the recovery component's model. */
data class LinkRecoveryPresentation(
    val phase: LinkRecoveryPhase,
    val detail: String?,
)

data class LinkDevPreviewPresentation(
    val previewPort: CircleHostPreviewPort?,
    val portInspections: Flow<List<ProductPortInspection>>,
)

/** talk.command → capture.service.command. */
data class LinkCaptureCommandEvent(val operation: CaptureOperation)

/** active-playback.command → playback.service.command. */
data class LinkPlaybackCommandEvent(val operation: PlaybackOperation, val turnId: String)

/** composer.compose → conversation.service.compose. */
data class LinkComposeEvent(val text: String)

/** composer.edit → conversation.service.edit. */
data class LinkComposerEditEvent(val text: String)

/** latest.openAttachment → host.service.openAttachment. */
data class LinkOpenAttachmentEvent(val url: String)

/** public-link.command → session.service.command. */
data class LinkPublicLinkCommandEvent(val enabled: Boolean)

/** target.select → target.service.select. */
data class LinkTargetSelectEvent(val targetId: String)

/** preferences.toggle → preferences.service.toggle. */
data class LinkPreferenceToggleEvent(val key: LinkPreferenceKey, val enabled: Boolean)

/** updates.command → updates.service.command. */
data class LinkUpdateCommandEvent(val operation: LinkUpdateOperation)

/** settings-action.open / dev-host.open → navigation.service.openSettings/openDevHost. */
data class LinkRouteOpenEvent(val target: LinkRoute)

data object LinkNavigationBackEvent

/**
 * The one capture availability decision, shared by the port presentation and
 * the on-screen capture control. The selection intentionally covers every
 * known target, not only the picker's available subset: an offline target
 * that still accepts messages keeps capture ready, exactly as the screens
 * behaved before the port graph.
 */
fun LinkState.captureAvailability(microphoneGranted: Boolean): LinkCaptureAvailability {
    val selected = targets.firstOrNull { it.id == selectedTargetId } ?: targets.firstOrNull()
    return resolveLinkCaptureAvailability(
        hasTarget = selected != null,
        targetAcceptsMessages = selected?.acceptsMessages == true,
        microphoneGranted = microphoneGranted,
        finalizing = capture == CapturePhase.FINALIZING,
    )
}

fun LinkState.toCapturePresentation(
    microphoneGranted: Boolean,
    byteCount: Long,
    byteLimit: Long?,
    level: Float,
): LinkCapturePresentation {
    val availability = captureAvailability(microphoneGranted)
    return LinkCapturePresentation(
        phase = capture,
        available = availability == LinkCaptureAvailability.Ready,
        unavailableReason = when (availability) {
            LinkCaptureAvailability.Ready -> null
            is LinkCaptureAvailability.Recoverable -> "${availability.label} · ${availability.detail}"
            is LinkCaptureAvailability.Blocked -> "${availability.label} · ${availability.detail}"
        },
        recoveryActionAvailable = availability is LinkCaptureAvailability.Recoverable,
        startedAtMs = captureStartedAtMs.takeIf { it > 0L },
        byteCount = byteCount,
        byteLimit = byteLimit,
        level = level.coerceIn(0f, 1f),
        sampledAtMs = System.currentTimeMillis(),
    )
}

fun LinkState.toConversationPresentation(draftText: String): LinkConversationPresentation {
    val turn = turns.lastOrNull()
    return LinkConversationPresentation(
        turnId = turn?.turnId,
        deliveryPhase = turn?.deliveryPhase ?: DeliveryPhase.NONE,
        replyPhase = turn?.replyPhase ?: ReplyPhase.NONE,
        offline = connection != ConnectionState.CONNECTED,
        idempotencyKey = turn?.turnId,
        draftText = draftText,
        turns = turns,
    )
}

fun LinkState.toPlaybackPresentation(): LinkPlaybackPresentation {
    val turn = activePlaybackTurnId?.let { id ->
        turns.firstOrNull { it.turnId == id }
    } ?: turns.lastOrNull()
    return LinkPlaybackPresentation(
        turnId = turn?.turnId,
        phase = turn?.playbackPhase ?: PlaybackPhase.IDLE,
        positionMs = turn?.playbackPositionMs ?: 0L,
        durationMs = turn?.playbackDurationMs ?: 0L,
        turn = turn,
    )
}

fun LinkState.toTargetPresentation(kindOf: (String) -> LinkTargetKind?): LinkTargetPresentation {
    val available = targets.filter { it.available }
    val selected = available.firstOrNull { it.id == selectedTargetId } ?: available.firstOrNull()
    return LinkTargetPresentation(
        selectedTargetId = selected?.id,
        kind = selected?.let { kindOf(it.id) } ?: LinkTargetKind.NONE,
        availableCount = available.size,
        targets = available,
    )
}

fun LinkState.toSessionPresentation(publicLinkActive: Boolean): LinkSessionPresentation =
    LinkSessionPresentation(
        connection = connection,
        connectionDetail = connectionDetail.takeIf { it.isNotBlank() },
        publicLinkActive = publicLinkActive,
    )

fun LinkState.toHistoryPresentation(): LinkHistoryPresentation = LinkHistoryPresentation(
    retainedTurns = turns.size,
    maxTurns = LinkHistoryPolicy.MAX_LOCAL_TURNS,
)

fun LinkState.toPreferencesPresentation(speakReplies: Boolean): LinkPreferencesPresentation =
    LinkPreferencesPresentation(
        handsFree = handsFree,
        speakReplies = speakReplies,
    )

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

fun UpdateState.toUpdatePresentation(currentVersionName: String): LinkUpdatePresentation =
    LinkUpdatePresentation(phase = wirePhase(), update = this, currentVersionName = currentVersionName)

fun LinkState.toRecoveryPresentation(): LinkRecoveryPresentation {
    val error = recoveryError
    val phase = if (error.isBlank()) LinkRecoveryPhase.CLEAN else LinkRecoveryPhase.QUARANTINED
    return LinkRecoveryPresentation(
        phase = phase,
        detail = error.takeIf { it.isNotBlank() },
    )
}
