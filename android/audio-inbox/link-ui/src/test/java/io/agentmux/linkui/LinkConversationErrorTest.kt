package io.agentmux.linkui

import org.junit.Assert.assertEquals
import org.junit.Test

// Mattias 2026-09-14 screenshots: Link showed raw transport text to a person.
class LinkConversationErrorTest {
    @Test fun transportFailuresReadAsWhatHappenedAndWhatToDo() {
        val lost = "Connection lost. Try again."
        assertEquals(lost, linkConversationError("Software caused connection abort"))
        assertEquals(lost, linkConversationError("timeout"))
        assertEquals(lost, linkConversationError("Read timed out"))
        assertEquals(lost, linkConversationError("reply feed closed before completion"))
        assertEquals(lost, linkConversationError("Connection reset"))
        assertEquals(lost, linkConversationError("Unable to resolve host \"abyss-win.tail13cb13.ts.net\": No address associated with hostname"))
        assertEquals(lost, linkConversationError("failed to connect to abyss-win.tail13cb13.ts.net/100.64.0.1 (port 443)"))
        assertEquals("Server unavailable. Try again.", linkConversationError("PTT HTTP 502"))
        assertEquals("Server unavailable. Try again.", linkConversationError("reply feed HTTP 503"))
    }

    @Test fun serverExplanationsAndKnownCopyStayAsTheyAre() {
        assertEquals("No speech detected. Try again.", linkConversationError("transcription empty"))
        assertEquals("PTT target is not a configured audio inbox", linkConversationError("PTT target is not a configured audio inbox"))
    }
}
