package io.agentmux.audioinbox.wear

import io.agentmux.linkcore.ConnectionState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class WearUnavailableStateTest {
    @Test
    fun `wear asks for phone login without fabricating targets`() {
        val state = unavailableState()

        assertEquals(ConnectionState.CONFIGURATION_REQUIRED, state.connection)
        assertEquals("LOGGA IN PÅ TELEFONEN", state.connectionDetail)
        assertEquals(emptyList<String>(), state.targets.map { it.id })
        assertFalse(state.targets.any { it.available })
    }
}
