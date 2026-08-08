package io.agentmux.audioinbox

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.lifecycle.lifecycleScope
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.toArgb
import com.adelost.designkit.ui.CircleHostSurface
import com.adelost.designkit.ui.GraphiteTokens
import com.adelost.designkit.ui.requestedOrientationFor
import io.agentmux.audioinbox.update.LinkReleaseCatalogs
import io.agentmux.audioinbox.update.LinkUpdater
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkui.product.LinkNavigationController
import io.agentmux.linkui.product.LinkRoute
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * WHAT: Builds the phone Compose surface and its lifecycle-owned controllers.
 * WHY: Keeps presentation setup separate from durable transport and playback services.
 */
class MainActivity : ComponentActivity() {
    private lateinit var coordinator: LinkCoordinator
    private lateinit var recorder: PushToTalkRecorder
    private lateinit var updater: LinkUpdater
    private lateinit var host: LinkHostController
    private lateinit var productGraph: PhoneLinkProductGraph
    private val microphoneGranted = MutableStateFlow(false)
    private val microphonePermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> microphoneGranted.value = granted }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = GraphiteTokens.Canvas.toArgb()
        window.navigationBarColor = GraphiteTokens.Canvas.toArgb()
        coordinator = LinkCoordinator(this)
        host = LinkHostController(this) { requestedOrientation = requestedOrientationFor(it) }
        if (BuildConfig.DEBUG) {
            host.applyQa(
                mode = intent?.getStringExtra("qa_host"),
                diameter = intent?.getStringExtra("qa_watch_diameter"),
                orientation = intent?.getStringExtra("qa_orientation"),
            )
        }
        host.restoreOrientation()
        microphoneGranted.value = hasMicrophonePermission()
        coordinator.handlePublicAuth(intent?.data)
        recorder = PushToTalkRecorder(this)
        updater = LinkUpdater(
            context = this,
            scope = lifecycleScope,
            catalog = LinkReleaseCatalogs.PHONE,
            currentVersionName = BuildConfig.VERSION_NAME,
            currentVersionCode = BuildConfig.VERSION_CODE,
        )
        val qaActive = BuildConfig.DEBUG && intent?.getStringExtra(QA_STATE_EXTRA) == QA_STATE_ACTIVE
        val qaPage = if (BuildConfig.DEBUG) intent?.getStringExtra(QA_PAGE_EXTRA) else null
        val qaPlayback = BuildConfig.DEBUG && intent?.getStringExtra(QA_PLAYBACK_EXTRA) == QA_PLAYBACK_ACTIVE
        val navigation = LinkNavigationController(
            initial = savedInstanceState?.getString(STATE_ROUTE)?.let(::routeByWireId)
                ?: when (qaPage) {
                    QA_PAGE_DEV_HOST -> LinkRoute.DEV_HOST
                    QA_PAGE_SETTINGS -> LinkRoute.SETTINGS
                    else -> LinkRoute.HOME
                },
        )
        productGraph = if (qaActive) {
            PhoneLinkProductGraph.qa(
                qaState = MutableStateFlow(phoneActivePreviewState(qaPlayback)),
                updateState = if (qaPage == QA_PAGE_SETTINGS) {
                    MutableStateFlow(phoneQaUpdateState())
                } else {
                    updater.state
                },
                coordinator = coordinator,
                updater = updater,
                navigation = navigation,
            )
        } else {
            PhoneLinkProductGraph.real(
                coordinator = coordinator,
                recorder = recorder,
                updater = updater,
                navigation = navigation,
                microphoneGranted = microphoneGranted,
            )
        }
        setContent {
            val preview by host.state.collectAsState()
            CircleHostSurface(
                isWatchDevice = false,
                state = preview,
                onStateChange = host::update,
            ) {
                LinkPhoneScreen(
                    graph = productGraph,
                    currentVersionName = updater.currentVersionName,
                    hostPreview = host.port,
                    onRequestMicrophone = ::requestMicrophone,
                    recordedBytes = recorder::currentBytes,
                    recordedLevel = if (qaActive) ::qaRecordedLevel else recorder::currentLevel,
                    onPublicLink = ::onPublicLink,
                )
            }
        }
        requestRuntimePermissions()
        updater.start()
    }

    override fun onStop() {
        if (coordinator.state.value.capture == CapturePhase.LISTENING) {
            recorder.cancel()
            coordinator.capture(CapturePhase.FAILED)
        }
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        microphoneGranted.value = hasMicrophonePermission()
        if (::updater.isInitialized) updater.resumeInstallerStatus()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        coordinator.handlePublicAuth(intent.data)
        if (BuildConfig.DEBUG && ::host.isInitialized) {
            host.applyQa(
                mode = intent.getStringExtra("qa_host"),
                diameter = intent.getStringExtra("qa_watch_diameter"),
                orientation = intent.getStringExtra("qa_orientation"),
            )
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString(STATE_ROUTE, productGraph.navigation.route.value.wireId)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        // The updater has no executor of its own to shut down any more: its
        // work runs on lifecycleScope, which this activity cancels for us.
        productGraph.close()
        recorder.cancel()
        coordinator.close()
        super.onDestroy()
    }

    private fun onPublicLink() {
        if (coordinator.publicLoggedIn()) coordinator.logoutPublic() else coordinator.beginPublicLogin()
    }

    private fun hasMicrophonePermission(): Boolean =
        checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun requestMicrophone() {
        if (!hasMicrophonePermission()) {
            microphonePermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    private fun requestRuntimePermissions() {
        val permissions = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            permissions += Manifest.permission.POST_NOTIFICATIONS
        }
        if (permissions.isNotEmpty()) requestPermissions(permissions.toTypedArray(), 1)
    }

    private companion object {
        const val STATE_ROUTE = "io.agentmux.audioinbox.ROUTE"
        const val QA_STATE_EXTRA = "qa_state"
        const val QA_STATE_ACTIVE = "active"
        const val QA_PAGE_EXTRA = "qa_page"
        const val QA_PAGE_SETTINGS = "settings"
        const val QA_PAGE_DEV_HOST = "dev-host"
        const val QA_PLAYBACK_EXTRA = "qa_playback"
        const val QA_PLAYBACK_ACTIVE = "active"
    }
}

private fun routeByWireId(wireId: String): LinkRoute? =
    LinkRoute.entries.firstOrNull { it.wireId == wireId }
