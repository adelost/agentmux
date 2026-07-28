package io.agentmux.audioinbox.wear

import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WearLinkScreenTest {
    @Test
    fun unavailableStateIsConciseCanonicalRows() {
        val rows = wearLinkRows(
            state = unavailableState(),
            onSelectTarget = {},
            onHoldToTalk = {},
            onPlay = {},
            onStop = {},
            onReplay = {},
        )

        assertEquals(listOf("target", "talk", "latest", "settings"), rows.map { it.key })
        assertEquals("AGENT · PAIRING", rows[0].title)
        assertEquals("LSRC:3", rows[0].sub)
        assertTrue(rows[0].choices.isEmpty())
        assertNull(rows[1].onTap)
        assertFalse(rows[1].holdToConfirm)
        assertEquals("OPEN PHONE TO PAIR", wearLinkSettingsRows(unavailableState())[0].sub)
    }

    @Test
    fun connectedStateExposesChoiceHoldAndPlaybackThroughRowData() {
        var selected = ""
        var talked = false
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

        val rows = wearLinkRows(
            state = state,
            onSelectTarget = { selected = it },
            onHoldToTalk = { talked = true },
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
        assertTrue(rows[1].holdToConfirm)
        assertNotNull(rows[1].onTap)
        rows[1].onTap?.invoke()
        assertTrue(talked)
        assertEquals("REPLAY", rows[3].title)
        rows[3].onTap?.invoke()
        assertTrue(replayed)
    }
}
