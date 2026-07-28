package io.agentmux.audioinbox.wear

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkAction
import io.agentmux.linkcore.LinkReducer
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.ReplyPhase

/**
 * WHAT: Builds the deliberately small round-watch presentation surface.
 * WHY: Keeps Wear navigation independent from the phone timeline implementation.
 */
class WearMainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val state = if (BuildConfig.DEBUG && intent.getStringExtra(QA_STATE_EXTRA) == QA_STATE_ACTIVE) {
            activePreviewState()
        } else {
            unavailableState()
        }
        setContent {
            WearLinkScreen(
                state = state,
                onSelectTarget = {},
                onHoldToTalk = {},
                onPlay = {},
                onStop = {},
                onReplay = {},
            )
        }
    }
}

private const val QA_STATE_EXTRA = "qa_state"
private const val QA_STATE_ACTIVE = "active"

internal fun unavailableState(): LinkState {
    val targets = listOf("lsrc:3", "lsrc:10", "_windows_").map {
        LinkTarget(it, it, available = false)
    }
    return listOf<LinkAction>(
        LinkAction.Targets(targets),
        LinkAction.Connection(
            ConnectionState.CONFIGURATION_REQUIRED,
            "Public Link pairing is not available yet",
        ),
    ).fold(LinkState(), LinkReducer::reduce)
}

internal fun activePreviewState(): LinkState = LinkState(
    connection = ConnectionState.CONNECTED,
    connectionDetail = "Private relay ready",
    targets = listOf(
        LinkTarget("skyvw:3", "Skyvw 3"),
        LinkTarget("skyvw:9", "Skyvw 9"),
    ),
    selectedTargetId = "skyvw:3",
    turns = listOf(
        LinkTurn(
            turnId = "preview-1",
            targetId = "skyvw:3",
            targetLabel = "Skyvw 3",
            userText = "Status?",
            replyText = "Wear link is ready.",
            respondingTarget = "skyvw:3",
            createdAtMs = 1L,
            deliveryPhase = DeliveryPhase.QUEUED,
            replyPhase = ReplyPhase.READY,
            playbackPhase = PlaybackPhase.STOPPED,
        ),
    ),
)
