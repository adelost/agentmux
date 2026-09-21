package io.agentmux.linkui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// Mattias 2026-09-14 21:42: "bara minimal text ... så kort det bara kan, punktform."
class LinkAudioPreferencesTest {
    @Test fun everyPreferenceExplainsItselfInAtMostTwoShortBullets() {
        val preferences = linkAudioPreferences(
            readReplies = false,
            announcements = false,
            wakeWord = true,
            listeningCueSound = false,
        )
        assertEquals("LISTENING SOUND", preferences.last().title)
        assertEquals(false, preferences.last().enabled)
        assertEquals("OFF", preferences.first().stateLabel)
        assertEquals(
            "ON",
            linkAudioPreferences(true, false, false, false).first().stateLabel,
        )
        preferences.forEach { preference ->
            val lines = preference.hint.lines()
            assertTrue("${preference.title}: ${lines.size} lines", lines.size in 1..2)
            lines.forEach { line ->
                assertTrue("${preference.title}: not a bullet: $line", line.startsWith("• "))
                assertTrue("${preference.title}: too long: $line", line.length <= 34)
            }
        }
    }
}
