package io.agentmux.audioinbox

import io.agentmux.linkcore.ConnectionState
import org.junit.Assert.assertEquals
import org.junit.Test

// Mattias 2026-09-15: "den här disconnected upp lite titt som tätt ... Den verkar fortfarande fungera".
class LinkConnectionReceiptTest {
    @Test
    fun withAnnouncementsOffTheAudioReceiptNeverChangesLinksConnection() {
        listOf("Disconnected", "Disconnected: Read timed out", "Playing", "Off", "Connected").forEach { raw ->
            assertEquals(raw, null, announcementFeedConnection(raw, announcementsOn = false))
        }
    }

    @Test
    fun aPlayedReplyOrAnOffFeedSaysNothingAboutTheRoute() {
        assertEquals(null, announcementFeedConnection("Playing", announcementsOn = true))
        assertEquals(null, announcementFeedConnection("Off", announcementsOn = true))
        assertEquals(null, announcementFeedConnection("Buffering the reply", announcementsOn = true))
    }

    @Test
    fun aRunningFeedStillReportsItsRealState() {
        assertEquals(ConnectionState.DISCONNECTED, announcementFeedConnection("Disconnected: feed HTTP 502", announcementsOn = true))
        assertEquals(ConnectionState.CONNECTED, announcementFeedConnection("Connected", announcementsOn = true))
        assertEquals(ConnectionState.CONNECTING, announcementFeedConnection("Connecting", announcementsOn = true))
    }
}
