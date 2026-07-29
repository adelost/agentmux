package io.agentmux.audioinbox.wear

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkAction
import io.agentmux.linkcore.LinkReducer
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.ReplyPhase

class WearMainActivity : ComponentActivity() {
    private lateinit var controller: WearMailboxController
    private val sessionChanges = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            controller.reloadSession()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        controller = WearMailboxController(this)
        registerSessionReceiver()
        requestMicrophone()
        controller.start()
        setContent {
            val liveState by controller.state.collectAsState()
            val state = if (
                BuildConfig.DEBUG &&
                intent.getStringExtra(QA_STATE_EXTRA) == QA_STATE_ACTIVE
            ) {
                activePreviewState()
            } else {
                liveState
            }
            WearLinkScreen(
                state = state,
                onSelectTarget = controller::selectTarget,
                onBeginCapture = controller::beginCapture,
                onReleaseCapture = controller::releaseCapture,
                onCancelCapture = controller::cancelCapture,
                recordedBytes = controller::recordedBytes,
                recordedLevel = controller::recordedLevel,
                onPlay = controller::playLatest,
                onStop = controller::stopPlayback,
                onReplay = controller::playLatest,
            )
        }
        refreshHandoff()
    }

    override fun onResume() {
        super.onResume()
        if (::controller.isInitialized) refreshHandoff()
    }

    override fun onDestroy() {
        unregisterReceiver(sessionChanges)
        controller.close()
        super.onDestroy()
    }

    private fun refreshHandoff() {
        WearSessionBootstrap.refresh(this) { result ->
            if (result == HandoffResult.STORED || result == HandoffResult.REVOKED) {
                runOnUiThread(controller::reloadSession)
            }
        }
    }

    private fun requestMicrophone() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 701)
        }
    }

    private fun registerSessionReceiver() {
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(
                sessionChanges,
                IntentFilter(ACTION_WEAR_SESSION_CHANGED),
                RECEIVER_NOT_EXPORTED,
            )
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(sessionChanges, IntentFilter(ACTION_WEAR_SESSION_CHANGED))
        }
    }
}

private const val QA_STATE_EXTRA = "qa_state"
private const val QA_STATE_ACTIVE = "active"

internal fun unavailableState(): LinkState = listOf<LinkAction>(
    LinkAction.Targets(emptyList()),
    LinkAction.Connection(
        ConnectionState.CONFIGURATION_REQUIRED,
        "LOGGA IN PÅ TELEFONEN",
    ),
).fold(LinkState(), LinkReducer::reduce)

internal fun activePreviewState(): LinkState = LinkState(
    connection = ConnectionState.CONNECTED,
    connectionDetail = "LINK READY",
    targets = listOf(
        LinkTarget("demo:1", "Demo one"),
        LinkTarget("demo:2", "Demo two"),
    ),
    selectedTargetId = "demo:1",
    turns = listOf(
        LinkTurn(
            turnId = "preview-1",
            targetId = "demo:1",
            targetLabel = "Demo one",
            userText = "Status?",
            replyText = "Wear Link is ready.",
            respondingTarget = "demo:1",
            createdAtMs = 1L,
            deliveryPhase = DeliveryPhase.QUEUED,
            replyPhase = ReplyPhase.READY,
            playbackPhase = PlaybackPhase.STOPPED,
        ),
    ),
)
