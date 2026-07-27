package io.agentmux.audioinbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LinkStateRepositoryCorruptionTest {
    @Test
    fun `corrupt v2 is quarantined and never reinterpreted as legacy`() {
        val preferences = TestPreferences()
        val corrupt = """{"schemaVersion":2,"turns":[broken}"""
        preferences.data[AppContract.KEY_LINK_STATE_V2] = corrupt
        preferences.data[AppContract.KEY_CONVERSATION] =
            """[{"role":"assistant","target":"wrong","text":"legacy fallback"}]"""

        val state = LinkStateRepository(preferences).load()

        assertTrue(state.turns.isEmpty())
        assertTrue(state.recoveryError.contains("quarantined"))
        assertEquals(corrupt, preferences.data[AppContract.KEY_LINK_STATE_V2_QUARANTINE])
    }
}
