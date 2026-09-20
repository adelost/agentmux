package io.agentmux.linkui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LinkListeningCueTest {
    @Test fun soundOnPlaysTheRiseAndHapticOnce() {
        var sound = 0
        var haptic = 0
        val cue = LinkListeningCue(
            soundEnabled = { true },
            playSound = { sound += 1 },
            playHaptic = { haptic += 1 },
        )

        cue.listeningStarted()

        assertEquals(1, sound)
        assertEquals(1, haptic)
    }

    @Test fun soundOffStillPlaysTheHaptic() {
        var sound = 0
        var haptic = 0
        val cue = LinkListeningCue(
            soundEnabled = { false },
            playSound = { sound += 1 },
            playHaptic = { haptic += 1 },
        )

        cue.listeningStarted()

        assertEquals(0, sound)
        assertEquals(1, haptic)
    }

    @Test fun theSoftRiseIsShortAndHasTwoIncreasingNotes() {
        assertEquals(listOf(660, 880), LinkListeningCuePattern.notes.map { it.frequencyHz })
        assertTrue(LinkListeningCuePattern.durationMs in 100..160)
        assertTrue(LinkListeningCuePattern.amplitude in 0.05f..0.12f)
        assertEquals(
            LinkListeningCuePattern.sampleRate * LinkListeningCuePattern.durationMs / 1_000,
            LinkListeningCuePattern.pcm().size,
        )
    }
}
