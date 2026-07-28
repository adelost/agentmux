package io.agentmux.linkcore

import org.junit.Assert.assertEquals
import org.junit.Test

class LinkConnectionPresentationTest {
    @Test
    fun `private route remains primary when public fallback is ready`() {
        val state = LinkState(
            connection = ConnectionState.CONNECTED,
            connectionDetail = "Connected via Tailscale · Public fallback ready",
        )

        assertEquals("PRIVATE", linkConnectionRoute(state))
    }

    @Test
    fun `public route is named when it is the only active route`() {
        val state = LinkState(
            connection = ConnectionState.CONNECTED,
            connectionDetail = "Connected via Public Link",
        )

        assertEquals("PUBLIC", linkConnectionRoute(state))
    }
}
