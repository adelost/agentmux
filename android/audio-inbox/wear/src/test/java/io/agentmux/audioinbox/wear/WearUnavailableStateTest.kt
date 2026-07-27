package io.agentmux.audioinbox.wear

import io.agentmux.linkcore.ConnectionState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class WearUnavailableStateTest {
    @Test
    fun `wear stays truthfully unavailable until public pairing is wired`() {
        val state = unavailableState()

        assertEquals(ConnectionState.CONFIGURATION_REQUIRED, state.connection)
        assertEquals(listOf("lsrc:3", "lsrc:10", "_windows_"), state.targets.map { it.id })
        assertFalse(state.targets.any { it.available })
    }
}
