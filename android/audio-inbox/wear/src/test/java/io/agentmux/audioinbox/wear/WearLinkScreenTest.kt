package io.agentmux.audioinbox.wear

import com.adelost.designkit.ui.CircleLabelProgress
import com.adelost.releasekit.UpdateState
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkui.linkWatchRows
import io.agentmux.linkui.linkWatchSettingsRows
import io.agentmux.linkui.product.LinkProductSession
import io.agentmux.linkui.product.generated.LinkArtifactProfile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

class WearLinkScreenTest {
    private val wearProduct = LinkProductSession(LinkArtifactProfile.WEAR_FULL_UI)
    private val phoneProduct = LinkProductSession(LinkArtifactProfile.PHONE_FULL_UI)

    @Test
    fun unavailableStateIsConciseCanonicalRows() {
        val rows = linkWatchRows(
            product = wearProduct,
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
        assertEquals(
            "LOG IN ON PHONE",
            linkWatchSettingsRows(
                product = wearProduct,
                state = unavailableState(),
                updateState = UpdateState.UpToDate("1.2.1", publishedAtEpochMillis = null),
                currentVersionName = "1.2.1",
            )[0].sub,
        )
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
            product = wearProduct,
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
            product = wearProduct,
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
            product = wearProduct,
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
        val downloading = UpdateState.Downloading(
            versionName = "0.1.1",
            progress = 0.4f,
        )
        val downloadingRow = linkWatchSettingsRows(wearProduct, LinkState(), downloading, "0.1.0")[1]
        assertEquals("UPDATE", downloadingRow.title)
        assertEquals("DOWNLOADING… 40%", downloadingRow.sub)
        assertEquals(
            CircleLabelProgress.Determinate(0.4f),
            downloadingRow.labelProgress,
        )
        assertNull(downloadingRow.onTap)

        val ready = UpdateState.ReadyToInstall(
            versionName = "0.1.1",
            apkPath = "/cache/update.apk",
        )
        val readyRow = linkWatchSettingsRows(
            product = wearProduct,
            state = LinkState(),
            updateState = ready,
            currentVersionName = "0.1.0",
            onInstallUpdate = { installed = true },
        )[1]
        assertNotNull(readyRow.onTap)
        readyRow.onTap?.invoke()
        assertTrue(installed)
    }

    @Test
    fun currentReleaseKeepsItsSignedPublicationEpochAtTheSharedUiBoundary() {
        val publishedAt = Instant.parse("2026-08-02T05:33:20Z").toEpochMilli()
        val rows = linkWatchSettingsRows(
            product = wearProduct,
            state = LinkState(),
            updateState = UpdateState.UpToDate(
                versionName = "1.2.2",
                publishedAtEpochMillis = publishedAt,
            ),
            currentVersionName = "1.2.2",
            zoneId = ZoneId.of("Europe/Stockholm"),
            locale = Locale.US,
        )

        assertEquals(listOf("connection", "update", "update-published"), rows.map { it.key })
        assertEquals("PUBLISHED", rows.last().title)
        assertEquals("v1.2.2 · Aug 2, 2026, 7:33 AM", rows.last().sub)
    }

    @Test
    fun realWearOmitsPhoneHostControlsWhilePhoneWatchExactCanReturnToResponsive() {
        val state = activePreviewState()

        assertFalse(
            linkWatchSettingsRows(
                product = wearProduct,
                state = state,
                updateState = UpdateState.UpToDate("1.2.1", publishedAtEpochMillis = null),
                currentVersionName = "1.2.1",
            )
                .any { it.key == "dev-host" },
        )
        assertTrue(
            linkWatchSettingsRows(
                product = phoneProduct,
                state = state,
                updateState = UpdateState.UpToDate("1.2.1", publishedAtEpochMillis = null),
                currentVersionName = "1.2.1",
                onOpenDevHost = {},
            ).any {
                it.key == "dev-host" && it.sub == "RESPONSIVE · WATCH EXACT"
            },
        )
    }
}
