package io.agentmux.audioinbox.wear

import com.adelost.designkit.ui.CircleLabelProgress
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.UpdatePresentation
import io.agentmux.linkui.linkWatchRows
import io.agentmux.linkui.linkWatchSettingsRows
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WearLinkScreenTest {
    @Test
    fun unavailableStateIsConciseCanonicalRows() {
        val rows = linkWatchRows(
            state = unavailableState(),
            onSelectTarget = {},
            onOpenCapture = {},
            onPlay = {},
            onStop = {},
            onReplay = {},
        )

        assertEquals(listOf("target", "talk", "latest", "settings"), rows.map { it.key })
        assertEquals("AGENT · SIGN IN", rows[0].title)
        assertEquals("NO TARGET", rows[0].sub)
        assertTrue(rows[0].choices.isEmpty())
        assertNull(rows[1].onTap)
        assertFalse(rows[1].holdToConfirm)
        assertEquals("LOG IN ON PHONE", linkWatchSettingsRows(unavailableState())[0].sub)
    }

    @Test
    fun connectedStateExposesChoiceHoldAndPlaybackThroughRowData() {
        var selected = ""
        var openedCapture = false
        var replayed = false
        val state = LinkState(
            connection = ConnectionState.CONNECTED,
            connectionDetail = "Private relay ready",
            targets = listOf(
                LinkTarget("alpha", "Alpha"),
                LinkTarget("beta", "Beta"),
            ),
            selectedTargetId = "beta",
            turns = listOf(
                LinkTurn(
                    turnId = "turn-1",
                    targetId = "beta",
                    targetLabel = "Beta",
                    userText = "Status?",
                    replyText = "Ready.",
                    respondingTarget = "beta",
                    createdAtMs = 1L,
                    playbackPhase = PlaybackPhase.STOPPED,
                ),
            ),
        )

        val rows = linkWatchRows(
            state = state,
            onSelectTarget = { selected = it },
            onOpenCapture = { openedCapture = true },
            onPlay = {},
            onStop = {},
            onReplay = { replayed = true },
        )

        assertEquals(listOf("target", "talk", "latest", "playback", "settings"), rows.map { it.key })
        assertEquals("AGENT · PRIVATE", rows[0].title)
        assertEquals("BETA", rows[0].sub)
        assertEquals(listOf("ALPHA", "BETA"), rows[0].choices)
        rows[0].onSelect?.invoke("ALPHA")
        assertEquals("alpha", selected)
        assertFalse(rows[1].holdToConfirm)
        assertNotNull(rows[1].onTap)
        rows[1].onTap?.invoke()
        assertTrue(openedCapture)
        assertEquals("REPLAY", rows[3].title)
        rows[3].onTap?.invoke()
        assertTrue(replayed)
    }

    @Test
    fun publicConnectionAndTerminalFailureAreRenderedTruthfully() {
        val state = LinkState(
            connection = ConnectionState.CONNECTED,
            connectionDetail = "PUBLIC LINK · test identity",
            targets = listOf(LinkTarget("alpha", "Alpha")),
            selectedTargetId = "alpha",
            turns = listOf(
                LinkTurn(
                    turnId = "turn-failed",
                    targetId = "alpha",
                    targetLabel = "Alpha",
                    userText = "Voice message",
                    createdAtMs = 1L,
                    deliveryPhase = DeliveryPhase.FAILED,
                    deliveryError = "transcription-failed",
                ),
            ),
        )

        val rows = linkWatchRows(
            state = state,
            onSelectTarget = {},
            onOpenCapture = {},
            onPlay = {},
            onStop = {},
            onReplay = {},
        )

        assertEquals("AGENT · PUBLIC", rows[0].title)
        assertEquals("TRANSCRIPTION-FAILED", rows[2].sub)
    }

    @Test
    fun unavailableTtsIsVisibleAndRetryable() {
        var retried = false
        val state = LinkState(
            connection = ConnectionState.CONNECTED,
            connectionDetail = "PUBLIC LINK",
            targets = listOf(LinkTarget("alpha", "Alpha")),
            selectedTargetId = "alpha",
            turns = listOf(
                LinkTurn(
                    turnId = "turn-replied",
                    targetId = "alpha",
                    targetLabel = "Alpha",
                    userText = "Status",
                    replyText = "Ready",
                    createdAtMs = 1L,
                    playbackPhase = PlaybackPhase.FAILED,
                    playbackError = "TTS unavailable",
                ),
            ),
        )

        val rows = linkWatchRows(
            state = state,
            onSelectTarget = {},
            onOpenCapture = {},
            onPlay = {},
            onStop = {},
            onReplay = { retried = true },
        )

        assertEquals("RETRY PLAYBACK", rows[3].title)
        assertEquals("TTS UNAVAILABLE", rows[3].sub)
        rows[3].onTap?.invoke()
        assertTrue(retried)
    }

    @Test
    fun updateRowUsesSharedProgressAndActionTruth() {
        var installed = false
        val downloading = LinkState(
            update = UpdatePresentation(
                currentVersion = "0.1.0 (1)",
                availableVersion = "0.1.1",
                state = "downloading",
                detail = "DOWNLOADING… 40%",
                progress = 0.4f,
            ),
        )
        val downloadingRow = linkWatchSettingsRows(downloading)[1]
        assertEquals("UPDATE", downloadingRow.title)
        assertEquals("DOWNLOADING… 40%", downloadingRow.sub)
        assertEquals(
            CircleLabelProgress.Determinate(0.4f),
            downloadingRow.labelProgress,
        )
        assertNull(downloadingRow.onTap)

        val ready = downloading.copy(
            update = downloading.update.copy(
                state = "ready-to-install",
                detail = "v0.1.1 READY · TAP",
                progress = 1f,
                canInstall = true,
            ),
        )
        val readyRow = linkWatchSettingsRows(
            state = ready,
            onInstallUpdate = { installed = true },
        )[1]
        assertNotNull(readyRow.onTap)
        readyRow.onTap?.invoke()
        assertTrue(installed)
    }
}
