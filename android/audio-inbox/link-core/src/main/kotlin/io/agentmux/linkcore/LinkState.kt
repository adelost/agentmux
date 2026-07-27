package io.agentmux.linkcore

enum class ConnectionState {
    OFF,
    CONNECTING,
    CONNECTED,
    DISCONNECTED,
    CONFIGURATION_REQUIRED,
}

enum class CapturePhase {
    IDLE,
    LISTENING,
    FINALIZING,
    FAILED,
}

enum class DeliveryPhase {
    SENDING,
    QUEUED,
    FAILED,
}

enum class ReplyPhase {
    NONE,
    THINKING,
    READY,
    FAILED,
}

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

data class LinkTarget(
    val id: String,
    val label: String,
    val available: Boolean = true,
)

data class LinkTurn(
    val turnId: String,
    val targetId: String,
    val targetLabel: String,
    val userText: String,
    val replyText: String = "",
    val respondingTarget: String = "",
    val createdAtMs: Long,
    val deliveryPhase: DeliveryPhase = DeliveryPhase.SENDING,
    val replyPhase: ReplyPhase = ReplyPhase.NONE,
    val playbackPhase: PlaybackPhase = PlaybackPhase.IDLE,
    val deliveryError: String = "",
    val replyError: String = "",
    val playbackError: String = "",
)

data class LinkState(
    val connection: ConnectionState = ConnectionState.OFF,
    val connectionDetail: String = "Off",
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
