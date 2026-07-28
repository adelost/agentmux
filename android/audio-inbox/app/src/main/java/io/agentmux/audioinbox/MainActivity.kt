package io.agentmux.audioinbox

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.lifecycle.lifecycleScope
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.graphics.toArgb
import com.adelost.designkit.ui.GraphiteTokens
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.LinkAction

/**
 * WHAT: Builds the phone Compose surface and its lifecycle-owned controllers.
 * WHY: Keeps presentation setup separate from durable transport and playback services.
 */
class MainActivity : ComponentActivity() {
    private lateinit var coordinator: LinkCoordinator
    private lateinit var recorder: PushToTalkRecorder
    private lateinit var updater: LinkUpdater

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = GraphiteTokens.Canvas.toArgb()
        window.navigationBarColor = GraphiteTokens.Canvas.toArgb()
        coordinator = LinkCoordinator(this)
        coordinator.handlePublicAuth(intent?.data)
        recorder = PushToTalkRecorder(this)
        updater = LinkUpdater(this, lifecycleScope) { presentation ->
            coordinator.applyUpdatePresentation(LinkAction.Update(presentation))
        }
        setContent {
            LinkPhoneScreen(coordinator, recorder, updater)
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
        // The updater has no executor of its own to shut down any more: its
        // work runs on lifecycleScope, which this activity cancels for us.
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
