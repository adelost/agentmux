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

        assertEquals(listOf("connection", "target", "talk", "latest"), rows.map { it.key })
        assertEquals("PAIRING", rows[0].title)
        assertEquals("OPEN PHONE TO PAIR", rows[0].sub)
        assertEquals("LSRC:3", rows[1].sub)
        assertTrue(rows[1].choices.isEmpty())
        assertNull(rows[2].onTap)
        assertFalse(rows[2].holdToConfirm)
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

        assertEquals(listOf("connection", "target", "talk", "latest", "playback"), rows.map { it.key })
        assertEquals(listOf("ALPHA", "BETA"), rows[1].choices)
        rows[1].onSelect?.invoke("ALPHA")
        assertEquals("alpha", selected)
        assertTrue(rows[2].holdToConfirm)
        assertNotNull(rows[2].onTap)
        rows[2].onTap?.invoke()
        assertTrue(talked)
        assertEquals("REPLAY", rows[4].title)
        rows[4].onTap?.invoke()
        assertTrue(replayed)
    }
}
