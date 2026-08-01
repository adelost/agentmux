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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.toArgb
import com.adelost.designkit.ui.GraphiteTokens
import io.agentmux.audioinbox.update.LinkReleaseCatalogs
import io.agentmux.audioinbox.update.LinkUpdater
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
    private val microphoneGranted = mutableStateOf(false)
    private val microphonePermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> microphoneGranted.value = granted }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = GraphiteTokens.Canvas.toArgb()
        window.navigationBarColor = GraphiteTokens.Canvas.toArgb()
        coordinator = LinkCoordinator(this)
        microphoneGranted.value = hasMicrophonePermission()
        coordinator.handlePublicAuth(intent?.data)
        recorder = PushToTalkRecorder(this)
        updater = LinkUpdater(
            context = this,
            scope = lifecycleScope,
            catalog = LinkReleaseCatalogs.PHONE,
            currentVersionName = BuildConfig.VERSION_NAME,
            currentVersionCode = BuildConfig.VERSION_CODE,
        ) { presentation ->
            coordinator.applyUpdatePresentation(LinkAction.Update(presentation))
        }
        setContent {
            LinkPhoneScreen(
                coordinator = coordinator,
                recorder = recorder,
                updater = updater,
                microphoneGranted = microphoneGranted.value,
                onRequestMicrophone = ::requestMicrophone,
            )
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
}
