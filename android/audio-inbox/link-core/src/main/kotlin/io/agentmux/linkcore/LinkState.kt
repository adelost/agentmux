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

/** User operations accepted by both Phone and Wear capture ports. */
enum class CaptureOperation {
    BEGIN,
    RELEASE,
    CANCEL,
}

/**
 * WHAT: Tracks durable acceptance for one outbound turn.
 * WHY: Keeps delivery failures distinct from reply and playback failures.
 */
enum class DeliveryPhase {
    NONE,
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

/** User operations accepted by the shared playback port. */
enum class PlaybackOperation {
    PLAY,
    PAUSE,
    RESUME,
    STOP,
}

/**
 * WHAT: Tracks session qualification for one target's last engine-observed model.
 * WHY: Prevents a previous session's model from appearing current.
 */
enum class LinkTargetModelStatus {
    CURRENT,
    STALE,
    UNKNOWN,
}

/**
 * WHAT: Stores observed model truth and configured launch intent.
 * WHY: Separates runtime evidence from launch configuration.
 */
data class LinkTargetModel(
    val status: LinkTargetModelStatus = LinkTargetModelStatus.UNKNOWN,
    val observedModel: String? = null,
    val observedEffort: String? = null,
    val configuredModel: String? = null,
    val configuredEffort: String? = null,
)

/**
 * WHAT: Describes one selectable agent target and its current availability.
 * WHY: Keeps favorite selection independent from transport implementation details.
 */
data class LinkTarget(
    val id: String,
    val label: String,
    val available: Boolean = true,
    /** Presence predicts latency; acceptance says whether a durable route can queue work. */
    val acceptsMessages: Boolean = available,
    val model: LinkTargetModel? = null,
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
    val playbackPositionMs: Long = 0,
    val playbackDurationMs: Long = 0,
    val deliveryError: String = "",
    val replyError: String = "",
    val playbackError: String = "",
) {
    init {
        require(playbackPositionMs >= 0L)
        require(playbackDurationMs >= 0L)
    }
}

/**
 * WHAT: Stores the immutable presentation state shared by phone and watch reducers.
 * WHY: Keeps Android surfaces from inventing divergent interaction state.
 */
data class LinkState(
    val connection: ConnectionState = ConnectionState.OFF,
    val connectionDetail: String = "Off",
    val connectionObservedAtMs: Long = 0,
    val targets: List<LinkTarget> = emptyList(),
    val selectedTargetId: String = "",
    val capture: CapturePhase = CapturePhase.IDLE,
    val captureStartedAtMs: Long = 0,
    val turns: List<LinkTurn> = emptyList(),
    val activePlaybackTurnId: String? = null,
    val handsFree: Boolean = false,
    val recoveryError: String = "",
)
