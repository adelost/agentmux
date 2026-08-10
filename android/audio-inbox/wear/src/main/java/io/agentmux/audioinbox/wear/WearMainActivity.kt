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
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import com.adelost.designkit.ui.CircleHostMode
import com.adelost.designkit.ui.CircleHostPreviewState
import com.adelost.designkit.ui.CircleHostSurface
import com.adelost.ringkit.ui.RingActionCueHost
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkAction
import io.agentmux.linkcore.LinkReducer
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.ReplyPhase
import io.agentmux.audioinbox.update.LinkReleaseCatalogs
import io.agentmux.audioinbox.update.LinkUpdater
import io.agentmux.linkui.LinkWatchScreen
import io.agentmux.linkui.product.LinkNavigationController
import io.agentmux.linkui.product.LinkRoute
import io.agentmux.linkui.product.generated.GeneratedLinkArtifactRef
import kotlinx.coroutines.flow.MutableStateFlow

class WearMainActivity : ComponentActivity() {
    private lateinit var controller: WearMailboxController
    private lateinit var productGraph: WearLinkProductGraph
    private lateinit var updater: LinkUpdater
    private val microphoneGranted = MutableStateFlow(false)
    private val microphonePermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> microphoneGranted.value = granted }
    private val sessionChanges = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            controller.reloadSession()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        controller = WearMailboxController(this)
        updater = LinkUpdater(
            context = this,
            scope = lifecycleScope,
            catalog = LinkReleaseCatalogs.WEAR,
            currentVersionName = BuildConfig.VERSION_NAME,
            currentVersionCode = BuildConfig.VERSION_CODE,
        )
        microphoneGranted.value = hasMicrophonePermission()
        val navigation = LinkNavigationController(
            artifact = GeneratedLinkArtifactRef.WEAR_FULL_UI,
            initial = savedInstanceState?.getString(STATE_ROUTE)
                ?.let { saved -> LinkRoute.entries.firstOrNull { it.wireId == saved } }
                ?: if (BuildConfig.DEBUG && intent.getStringExtra(QA_PAGE_EXTRA) == QA_PAGE_SETTINGS) {
                    LinkRoute.SETTINGS
                } else {
                    LinkRoute.HOME
                },
        )
        productGraph = WearLinkProductGraph.create(
            controller = controller,
            updater = updater,
            navigation = navigation,
            microphoneGranted = microphoneGranted,
            state = if (BuildConfig.DEBUG && intent.getStringExtra(QA_STATE_EXTRA) == QA_STATE_ACTIVE) {
                MutableStateFlow(activePreviewState())
            } else {
                controller.state
            },
        )
        registerSessionReceiver()
        requestMicrophone()
        controller.start()
        setContent {
            RingActionCueHost {
                CircleHostSurface(
                    isWatchDevice = true,
                    state = CircleHostPreviewState(mode = CircleHostMode.WATCH_EXACT),
                    onStateChange = null,
                ) {
                    LinkWatchScreen(
                        graph = productGraph,
                        currentVersionName = updater.currentVersionName,
                        onRequestMicrophone = ::requestMicrophone,
                        recordedBytes = controller::recordedBytes,
                        recordedLevel = controller::recordedLevel,
                    )
                }
            }
        }
        refreshHandoff()
        updater.start()
    }

    override fun onResume() {
        super.onResume()
        microphoneGranted.value = hasMicrophonePermission()
        if (::controller.isInitialized) refreshHandoff()
        if (::updater.isInitialized) updater.resumeInstallerStatus()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString(STATE_ROUTE, productGraph.navigation.route.value.wireId)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        unregisterReceiver(sessionChanges)
        productGraph.close()
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

    private fun hasMicrophonePermission(): Boolean =
        checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun requestMicrophone() {
        if (!hasMicrophonePermission()) {
            microphonePermission.launch(Manifest.permission.RECORD_AUDIO)
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

    private companion object {
        const val STATE_ROUTE = "io.agentmux.audioinbox.wear.ROUTE"
    }
}

private const val QA_STATE_EXTRA = "qa_state"
private const val QA_STATE_ACTIVE = "active"
private const val QA_PAGE_EXTRA = "qa_page"
private const val QA_PAGE_SETTINGS = "settings"

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
