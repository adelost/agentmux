package io.agentmux.audioinbox

import org.junit.Assert.assertEquals
import org.junit.Test

class ComposerDraftTest {
    @Test fun `megabyte paste is refused without losing the existing draft`() {
        val existing = ComposerDraft().edited("Keep this")
        assertEquals(existing, existing.edited("x".repeat(1_048_576)))
        val limit = io.agentmux.linkcore.LinkHistoryPolicy.MAX_COMPOSE_CHARS
        assertEquals(limit, existing.edited("x".repeat(limit)).text.length)
    }

    @Test
    fun `older acceptance never clears a newer or identically-worded draft`() {
        var draft = ComposerDraft().edited("Hej").submitted("turn-a")
        draft = draft.edited("Hej").submitted("turn-b")

        draft = draft.accepted("turn-a", "Hej")
        assertEquals("Hej", draft.text)

        draft = draft.accepted("turn-b", "Hej")
        assertEquals("", draft.text)
    }

    @Test
    fun `editing after send protects the unsent revision from acceptance`() {
        var draft = ComposerDraft().edited("first").submitted("turn-a")
        draft = draft.edited("second")

        draft = draft.accepted("turn-a", "first")

        assertEquals("second", draft.text)
    }
}
