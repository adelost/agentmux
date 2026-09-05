package io.agentmux.audioinbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.ReplyPhase

class LinkStateRepositoryCorruptionTest {
    @Test fun `oversized old history is rejected before JSON parsing without another huge copy`() {
        val preferences = TestPreferences()
        preferences.data[AppContract.KEY_LINK_STATE_V2] = "x".repeat(
            io.agentmux.linkcore.LinkHistoryPolicy.MAX_ENCODED_HISTORY_CHARS + 1)
        val restored = LinkStateRepository(preferences).load()
        assertTrue(restored.turns.isEmpty())
        assertTrue(restored.recoveryError.contains("Oversized"))
        assertTrue(!preferences.data.containsKey(AppContract.KEY_LINK_STATE_V2))
        assertTrue(!preferences.data.containsKey(AppContract.KEY_LINK_STATE_V2_QUARANTINE))
    }

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

    @Test
    fun `restart makes queued audio recoverable but never resumes interrupted playback`() {
        val preferences = TestPreferences()
        preferences.data[AppContract.KEY_LINK_STATE_V2] = """
            {
              "schemaVersion": 2,
              "selectedTargetId": "lsrc:3",
              "turns": [
                {
                  "turnId": "queued", "targetId": "lsrc:3", "userText": "one",
                  "replyText": "reply one", "createdAtMs": 1,
                  "deliveryPhase": "QUEUED", "replyPhase": "READY",
                  "playbackPhase": "QUEUED"
                },
                {
                  "turnId": "interrupted", "targetId": "lsrc:3", "userText": "two",
                  "replyText": "reply two", "createdAtMs": 2,
                  "deliveryPhase": "QUEUED", "replyPhase": "READY",
                  "playbackPhase": "PAUSED"
                }
              ]
            }
        """.trimIndent()

        val turns = LinkStateRepository(preferences).load().turns

        assertEquals(PlaybackPhase.IDLE, turns[0].playbackPhase)
        assertEquals(PlaybackPhase.STOPPED, turns[1].playbackPhase)
        assertEquals(listOf(ReplyPhase.READY, ReplyPhase.READY), turns.map { it.replyPhase })
        assertEquals(listOf("reply one", "reply two"), turns.map { it.replyText })
    }

    @Test
    fun `legacy JSON null strings never leak into conversation copy`() {
        val preferences = TestPreferences()
        preferences.data[AppContract.KEY_LINK_STATE_V2] = """
            {
              "schemaVersion": 2,
              "turns": [{
                "turnId": "old", "targetId": "lsrc:3", "targetLabel": null,
                "userText": "null", "replyText": null, "respondingTarget": "NULL",
                "createdAtMs": 1, "deliveryPhase": "QUEUED",
                "replyPhase": "NONE", "playbackPhase": "IDLE"
              }]
            }
        """.trimIndent()

        val turn = LinkStateRepository(preferences).load().turns.single()

        assertEquals("lsrc:3", turn.targetLabel)
        assertEquals("", turn.userText)
        assertEquals("", turn.replyText)
        assertEquals("", turn.respondingTarget)
    }
}
