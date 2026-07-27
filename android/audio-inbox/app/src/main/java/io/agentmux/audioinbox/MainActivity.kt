package io.agentmux.audioinbox

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.graphics.toArgb
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.LinkAction

/**
 * WHAT: Builds the phone Compose surface and its lifecycle-owned controllers.
 * WHY: Keeps presentation setup separate from durable transport and playback services.
 */
class MainActivity : ComponentActivity() {
    private lateinit var coordinator: LinkCoordinator
    private lateinit var recorder: PushToTalkRecorder
    private lateinit var updater: AppUpdater

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = LinkTokens.Canvas.toArgb()
        window.navigationBarColor = LinkTokens.Canvas.toArgb()
        coordinator = LinkCoordinator(this)
        coordinator.handlePublicAuth(intent?.data)
        recorder = PushToTalkRecorder(this)
        updater = AppUpdater(this) { presentation ->
            runOnUiThread {
                coordinator.applyUpdatePresentation(LinkAction.Update(presentation))
            }
        }
        setContent {
            AgentmuxLinkTheme {
                LinkPhoneScreen(coordinator, recorder, updater)
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
        if (::updater.isInitialized) updater.resumeInstallerStatus()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        coordinator.handlePublicAuth(intent.data)
    }

    override fun onDestroy() {
        updater.close()
        recorder.cancel()
        coordinator.close()
        super.onDestroy()
    }

    private fun requestRuntimePermissions() {
        val permissions = mutableListOf<String>()
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            permissions += Manifest.permission.RECORD_AUDIO
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            permissions += Manifest.permission.POST_NOTIFICATIONS
        }
        if (permissions.isNotEmpty()) requestPermissions(permissions.toTypedArray(), 1)
    }
}
