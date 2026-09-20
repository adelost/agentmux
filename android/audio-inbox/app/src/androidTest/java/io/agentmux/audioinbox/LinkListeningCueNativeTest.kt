package io.agentmux.audioinbox

import android.content.Context
import android.media.AudioAttributes
import android.os.Build
import android.os.Vibrator
import android.os.VibratorManager
import androidx.test.platform.app.InstrumentationRegistry
import io.agentmux.linkui.AndroidLinkListeningCue
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test

/** WHAT: Builds Android listening-feedback evidence. WHY: Keeps sound-off from silently removing haptic feedback. */
class LinkListeningCueNativeTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun soundOffRunsTheSharedHapticPathAndSoundUsesSystemSonification() {
        val vibrator = if (Build.VERSION.SDK_INT >= 31) {
            context.getSystemService(VibratorManager::class.java).defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Vibrator::class.java)
        }
        assumeTrue(vibrator.hasVibrator())
        vibrator.cancel()
        AndroidLinkListeningCue(context) { false }.use { cue -> cue.listeningStarted() }
        assertEquals(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION, AndroidLinkListeningCue.audioUsage)
    }
}
