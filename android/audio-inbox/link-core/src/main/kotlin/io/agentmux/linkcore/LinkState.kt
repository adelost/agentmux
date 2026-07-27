package io.agentmux.linkcore

/**
 * WHAT: Tracks transport connectivity independently from work or playback state.
 * WHY: Keeps a busy target from being mislabeled offline.
 */
enum class ConnectionState {
    OFF,
    CONNECTING,
    CONNECTED,
    DISCONNECTED,
    CONFIGURATION_REQUIRED,
}

/**
 * WHAT: Tracks the lifecycle of one user-owned push-to-talk capture.
 * WHY: Keeps recording gestures independent from send and reply jobs.
 */
enum class CapturePhase {
    IDLE,
    LISTENING,
    FINALIZING,
    FAILED,
}

/**
 * WHAT: Tracks durable acceptance for one outbound turn.
 * WHY: Keeps delivery failures distinct from reply and playback failures.
 */
enum class DeliveryPhase {
    SENDING,
    QUEUED,
    FAILED,
}

/**
 * WHAT: Tracks correlated model-response progress for one accepted turn.
 * WHY: Keeps slow replies from locking unrelated sends.
 */
enum class ReplyPhase {
    NONE,
    THINKING,
    READY,
    FAILED,
}

/**
 * WHAT: Tracks user-controlled audio playback for one ready reply.
 * WHY: Keeps stop and failure receipts from erasing successful reply delivery.
 */
enum class PlaybackPhase {
    IDLE,
    QUEUED,
    PLAYING,
    PAUSED,
    STOPPED,
    PLAYED,
    SKIPPED,
    FAILED,
}

/**
 * WHAT: Describes one selectable agent target and its current availability.
 * WHY: Keeps favorite selection independent from transport implementation details.
 */
data class LinkTarget(
    val id: String,
    val label: String,
    val available: Boolean = true,
)

/**
 * WHAT: Stores one conversation turn with independent delivery, reply, and playback axes.
 * WHY: Keeps concurrent turn truth from collapsing into one global busy phase.
 */
data class LinkTurn(
    val turnId: String,
    val targetId: String,
    val targetLabel: String,
    val userText: String,
    val replyText: String = "",
    val respondingTarget: String = "",
    val createdAtMs: Long,
    val replyReceivedAtMs: Long = 0,
    val deliveryPhase: DeliveryPhase = DeliveryPhase.SENDING,
    val replyPhase: ReplyPhase = ReplyPhase.NONE,
    val playbackPhase: PlaybackPhase = PlaybackPhase.IDLE,
    val deliveryError: String = "",
    val replyError: String = "",
    val playbackError: String = "",
)

/**
 * WHAT: Stores the immutable presentation state shared by phone and watch reducers.
 * WHY: Keeps Android surfaces from inventing divergent interaction state.
 */
data class LinkState(
    val connection: ConnectionState = ConnectionState.OFF,
    val connectionDetail: String = "Off",
    val connectionObservedAtMs: Long = 0,
    val targets: List<LinkTarget> = emptyList(),
    val selectedTargetId: String = "lsrc:3",
    val capture: CapturePhase = CapturePhase.IDLE,
    val captureStartedAtMs: Long = 0,
    val turns: List<LinkTurn> = emptyList(),
    val activePlaybackTurnId: String? = null,
    val handsFree: Boolean = false,
    val recoveryError: String = "",
    val update: UpdatePresentation = UpdatePresentation(),
)

/**
 * WHAT: Tracks signed-update progress and actionable installer state.
 * WHY: Keeps updater security machinery out of presentation code.
 */
data class UpdatePresentation(
    val currentVersion: String = "",
    val availableVersion: String = "",
    val state: String = "idle",
    val detail: String = "",
    val changelog: String = "",
    val progress: Float = 0f,
    val canInstall: Boolean = false,
    val canRetry: Boolean = false,
)
