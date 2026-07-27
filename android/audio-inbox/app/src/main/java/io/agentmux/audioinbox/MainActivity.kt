package io.agentmux.audioinbox

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.graphics.toArgb
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.LinkAction

class MainActivity : ComponentActivity() {
    private lateinit var coordinator: LinkCoordinator
    private lateinit var recorder: PushToTalkRecorder
    private lateinit var updater: AppUpdater

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = LinkTokens.Canvas.toArgb()
        window.navigationBarColor = LinkTokens.Canvas.toArgb()
        coordinator = LinkCoordinator(this)
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
        requestNotificationPermission()
        updater.start()
    }

    override fun onStop() {
        if (coordinator.state.value.capture == CapturePhase.LISTENING) {
            recorder.cancel()
            coordinator.capture(CapturePhase.FAILED)
        }
        super.onStop()
    }

    override fun onDestroy() {
        updater.close()
        recorder.cancel()
        coordinator.close()
        super.onDestroy()
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }
}
