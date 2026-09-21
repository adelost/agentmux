package io.agentmux.audioinbox

import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Rule
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue

/** WHAT: Checks named actions through the real Phone host. WHY: Keeps synthetic preview evidence on typed product sinks. */
class LinkUxSmokeTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val round get() = InstrumentationRegistry.getArguments().getString("host") == "round"
    private val landscape get() = InstrumentationRegistry.getArguments().getString("orientation") == "landscape"

    @Test fun recipientConversationAndSettings() {
        val favoritePreferences = instrumentation.targetContext
            .getSharedPreferences("link_recipient_favorites", 0)
        val originalFavorites = favoritePreferences.getStringSet("ids", null)?.toSet()
        favoritePreferences.edit().putStringSet("ids", setOf("demo:2")).commit()
        val launch = Intent(instrumentation.targetContext, MainActivity::class.java)
            .putExtra("qa_state", "active")
            .putExtra("qa_host", if (round) "WATCH_EXACT" else "RESPONSIVE")
            .putExtra("qa_watch_diameter", "216")
            .putExtra("qa_orientation", if (landscape) "DEG_90" else "DEG_0")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        try {
            ActivityScenario.launch<MainActivity>(launch).use { scenario ->
            compose.waitUntil(10_000) {
                compose.onAllNodes(hasContentDescription("TO demo:1", substring = true))
                    .fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNode(hasContentDescription("gpt-5.6-sol · xhigh", substring = true)).assertExists()
            shot("home")
            compose.onNode(hasContentDescription("TO demo:1", substring = true)).performClick()
            compose.waitForIdle()
            compose.onAllNodes(hasContentDescription("Astra orchestrator", substring = true)).assertCountEquals(0)
            shot("recipients-root")
            compose.onNode(hasContentDescription("ops", substring = true)).performScrollTo().performClick()
            compose.onNode(hasContentDescription("ops:0", substring = true)).assertExists()
            shot("recipients-group")
            compose.onNodeWithContentDescription("Back").performClick()
            compose.onNode(hasContentDescription("FAVORITES", substring = true)).performClick()
            shot("favorites")
            compose.onAllNodes(hasContentDescription("Previous worker", substring = true)).assertCountEquals(0)
            compose.onNodeWithContentDescription("Back").performClick()
            compose.onNode(hasContentDescription("demo:2", substring = true)).performClick()
            compose.onNode(hasContentDescription("TO demo:2", substring = true)).assertExists()
            compose.onNode(hasContentDescription("claude-fable-5 · Last seen", substring = true)).assertExists()
            shot("empty-conversation")
            if (!round) {
                compose.onNode(hasSetTextAction()).performTextInput("A draft stays here while I read.")
                shot("composer")
                scenario.onActivity { activity ->
                    activity.currentFocus?.clearFocus()
                    activity.window.insetsController?.hide(android.view.WindowInsets.Type.ime())
                }
                Thread.sleep(500)
                compose.waitForIdle()
                compose.waitUntil(3000) { compose.onAllNodesWithContentDescription("Open Link settings")
                    .fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithContentDescription("Open Link settings").performClick()
            } else {
                compose.onNode(hasContentDescription("SETTINGS", substring = true)).performScrollTo().performClick()
            }
            compose.waitForIdle()
            shot("settings-top")
            if (!round) {
                compose.onNode(hasScrollToIndexAction()).performScrollToNode(
                    hasContentDescription("ABOUT READ REPLIES"),
                )
                compose.onNodeWithContentDescription("ABOUT READ REPLIES").performClick()
                shot("info", 250)
                compose.onNodeWithContentDescription("Close information").performClick()
                compose.onNode(hasScrollToIndexAction()).performScrollToNode(
                    hasContentDescription("DISPLAY PREVIEW", substring = true))
                shot("settings-bottom")
                compose.onNode(hasContentDescription("DISPLAY PREVIEW", substring = true)).performClick()
                shot("display-preview")
            }
        }
        } finally {
            favoritePreferences.edit().apply {
                if (originalFavorites == null) remove("ids") else putStringSet("ids", originalFavorites)
            }.commit()
        }
    }

    @Test fun homeAudioControlsShareTheSettingsPreference() {
        if (round || landscape) return
        val context = instrumentation.targetContext
        val preferences = context.getSharedPreferences(AppContract.PREFS, 0)
        val hadSpeakReplies = preferences.contains(AppContract.KEY_SPEAK_REPLIES)
        val originalSpeakReplies = preferences.getBoolean(AppContract.KEY_SPEAK_REPLIES, false)
        preferences.edit().putBoolean(AppContract.KEY_SPEAK_REPLIES, false).commit()
        val launch = Intent(context, MainActivity::class.java)
            .putExtra("qa_state", "active")
            .putExtra("qa_host", "RESPONSIVE")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        try {
            ActivityScenario.launch<MainActivity>(launch).use {
                compose.waitUntil(10_000) {
                    compose.onAllNodes(hasContentDescription("READ REPLIES · OFF", substring = true))
                        .fetchSemanticsNodes().isNotEmpty()
                }
                compose.onNode(hasContentDescription("WAKE WORD", substring = true)).assertExists()
                compose.onNode(hasContentDescription("READ REPLIES · OFF", substring = true)).performClick()
                compose.onNode(hasContentDescription("READ REPLIES · ON", substring = true)).assertExists()
                assertTrue(preferences.getBoolean(AppContract.KEY_SPEAK_REPLIES, false))
                shot("home-audio-on")

                compose.onNodeWithContentDescription("Open Link settings").performClick()
                compose.onNode(hasContentDescription("READ REPLIES · ON", substring = true))
                    .performScrollTo().assertExists().performClick()
                compose.onNode(hasContentDescription("READ REPLIES · OFF", substring = true)).assertExists()
                compose.onNodeWithContentDescription("Back").performClick()
                compose.onNode(hasContentDescription("READ REPLIES · OFF", substring = true)).assertExists()
                assertEquals(false, preferences.getBoolean(AppContract.KEY_SPEAK_REPLIES, true))
                shot("home-audio-off")
            }
        } finally {
            preferences.edit().apply {
                if (hadSpeakReplies) putBoolean(AppContract.KEY_SPEAK_REPLIES, originalSpeakReplies)
                else remove(AppContract.KEY_SPEAK_REPLIES)
            }.commit()
        }
    }

    @Test fun longReplyStaysCompleteWithComposerAndStopReachable() {
        if (round || landscape) return
        val launch = Intent(instrumentation.targetContext, MainActivity::class.java)
            .putExtra("qa_state", "active")
            .putExtra("qa_case", "long-reply")
            .putExtra("qa_playback", "active")
            .putExtra("qa_host", "RESPONSIVE")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        ActivityScenario.launch<MainActivity>(launch).use {
            compose.waitUntil(10_000) {
                compose.onAllNodes(hasText("Paragraph 18 checks", substring = true))
                    .fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNode(hasText("Paragraph 18 checks", substring = true)).assertExists()
            compose.onNode(hasSetTextAction()).performTextInput("SYNTHETIC QA draft")
            compose.onNode(hasContentDescription("STOP", substring = true)).assertExists()
            shot("long-reply-font")
        }
    }

    @Test fun conversationStates() {
        // Indeterminate loading deliberately never idles. Freeze the Compose
        // animation clock, advance an actual frame, then inspect its UI.
        compose.mainClock.autoAdvance = false
        for (state in listOf("playing", "waiting", "error", "offline", "loading")) {
            val launch = Intent(instrumentation.targetContext, MainActivity::class.java)
                .putExtra("qa_state", "active")
                .putExtra("qa_case", state.takeUnless { it == "playing" })
                .putExtra("qa_playback", "active".takeIf { state == "playing" })
                .putExtra("qa_host", if (round) "WATCH_EXACT" else "RESPONSIVE")
                .putExtra("qa_orientation", if (landscape) "DEG_90" else "DEG_0")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            ActivityScenario.launch<MainActivity>(launch).use {
                compose.mainClock.advanceTimeBy(800)
                shot(state)
            }
        }
    }

    @Test fun heldMicrophoneShowsLiveFeedbackAndReleases() {
        if (round) return // Watch opens its dedicated capture surface first.
        val launch = Intent(instrumentation.targetContext, MainActivity::class.java)
            .putExtra("qa_state", "active").putExtra("qa_host", "RESPONSIVE")
            .putExtra("qa_orientation", if (landscape) "DEG_90" else "DEG_0")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        ActivityScenario.launch<MainActivity>(launch).use {
            compose.onNodeWithContentDescription("HOLD TO TALK").performTouchInput { down(center) }
            Thread.sleep(900)
            compose.onNodeWithText("RELEASE TO SEND").assertExists()
            shot("recording")
            compose.onRoot().performTouchInput { up() }
            compose.onNodeWithText("HOLD TO TALK").assertExists()
        }
    }

    @Test fun realAudioOwnerReplacesPausesAndCancelsLateHttp() {
        if (round || landscape) return // One native transport proof, not a host matrix.
        val context = instrumentation.targetContext
        val prefs = context.getSharedPreferences(AppContract.PREFS, 0)
        fun state(id: String) = prefs.getString("turn-playback:ux-$id", "")
        fun command(action: String) = context.startService(Intent(context, AudioInboxService::class.java).setAction(action))
        val launch = Intent(context, MainActivity::class.java).putExtra("qa_state", "active")
            .putExtra("qa_host", "RESPONSIVE").putExtra("qa_orientation", "DEG_0")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        ActivityScenario.launch<MainActivity>(launch).use {
            ReplyAudioHttpFixture().use { http ->
                fun play(id: String) = context.startForegroundService(Intent(context, AudioInboxService::class.java)
                    .setAction(AppContract.ACTION_REPLAY_REPLY)
                    .putExtra(AppContract.EXTRA_TURN_ID, "ux-$id")
                    .putExtra(AppContract.EXTRA_TEXT, "Audio proof $id")
                    .putExtra(AppContract.EXTRA_SERVER, http.url))
                try {
                    play("a")
                    compose.waitUntil(8000) { state("a") == "playing" }
                    play("b")
                    compose.waitUntil(8000) { state("b") == "playing" }
                    assertEquals("stopped", state("a"))
                    command(AppContract.ACTION_PAUSE_AUDIO)
                    compose.waitUntil(2000) { state("b") == "paused" }
                    command(AppContract.ACTION_RESUME_AUDIO)
                    compose.waitUntil(2000) { state("b") == "playing" }
                    play("c")
                    assertTrue(http.thirdRequested.await(8, java.util.concurrent.TimeUnit.SECONDS))
                    assertEquals("stopped", state("b"))
                    command(AppContract.ACTION_STOP_AUDIO)
                    compose.waitUntil(2000) { state("c") == "stopped" }
                    http.finishThird.countDown()
                    Thread.sleep(700)
                    assertEquals("stopped", state("c"))
                } finally {
                    command(AppContract.ACTION_STOP_AUDIO)
                    prefs.edit().apply { listOf("a", "b", "c").forEach { remove("turn-playback:ux-$it") } }.commit()
                }
            }
        }
    }

    @Test fun savedReplyReplaysOfflineAfterAudioServiceRestart() {
        val context = instrumentation.targetContext
        val prefs = context.getSharedPreferences(AppContract.PREFS, 0)
        val historyPrefs = context.getSharedPreferences("link-restart-proof", 0)
        val turn = io.agentmux.linkcore.LinkTurn("restart-proof", "local-fixture", "LOCAL TEST",
            "A question", replyText = "A retained reply for local audio proof.", createdAtMs = 1,
            replyPhase = io.agentmux.linkcore.ReplyPhase.READY)
        val repository = LinkStateRepository(historyPrefs)
        repository.save(io.agentmux.linkcore.LinkState(turns = listOf(turn)))
        val launch = Intent(context, MainActivity::class.java).putExtra("qa_state", "active")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        ActivityScenario.launch<MainActivity>(launch).use {
            val http = ReplyAudioHttpFixture(expectedRequests = 1)
            fun state() = prefs.getString("turn-playback:${turn.turnId}", "")
            fun play() {
                val restored = LinkStateRepository(historyPrefs).load().turns.single()
                assertEquals(turn.replyText, restored.replyText)
                context.startForegroundService(Intent(context, AudioInboxService::class.java)
                    .setAction(AppContract.ACTION_REPLAY_REPLY)
                    .putExtra(AppContract.EXTRA_TURN_ID, restored.turnId)
                    .putExtra(AppContract.EXTRA_TEXT, restored.replyText)
                    .putExtra(AppContract.EXTRA_SERVER, http.url))
            }
            try {
                play()
                compose.waitUntil(8000) { state() == "playing" }
                assertEquals(1, http.requests.get())
                http.close() // No server remains to disguise an accidental re-fetch.
                context.startService(Intent(context, AudioInboxService::class.java)
                    .setAction(AppContract.ACTION_STOP_AUDIO))
                compose.waitUntil(3000) { state() == "stopped" }
                context.stopService(Intent(context, AudioInboxService::class.java))
                val manager = context.getSystemService(android.app.ActivityManager::class.java)
                compose.waitUntil(5000) {
                    manager.getRunningServices(100).none { it.service.className == AudioInboxService::class.java.name }
                }
                val started = android.os.SystemClock.elapsedRealtime()
                play()
                compose.waitUntil(8000) { state() == "playing" }
                android.util.Log.i("LinkAudioProof", "offline replay after service restart: ${android.os.SystemClock.elapsedRealtime() - started} ms; HTTP requests=${http.requests.get()}")
                assertEquals(1, http.requests.get())
            } finally {
                http.close()
                context.stopService(Intent(context, AudioInboxService::class.java))
                historyPrefs.edit().clear().commit()
                prefs.edit().remove("turn-playback:${turn.turnId}").commit()
            }
        }
    }

    private fun shot(name: String, settleMs: Long = 500) {
        compose.waitForIdle()
        // A finite action receipt is allowed to finish before photographing
        // the destination. No network/readiness state is fabricated here.
        Thread.sleep(settleMs)
        val image = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
        val path = File(instrumentation.targetContext.getExternalFilesDir(null),
            "ux-${if (round) "round" else if (landscape) "wide" else "phone"}-$name.png")
        path.outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
        image.recycle()
    }
}
