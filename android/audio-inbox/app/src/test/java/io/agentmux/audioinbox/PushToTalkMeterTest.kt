package io.agentmux.audioinbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class PushToTalkMeterTest {
    @Test
    fun recorderAmplitudeIsNormalizedForTheSharedWaveform() {
        assertEquals(0f, normalizeAmplitude(0), 0f)
        assertEquals(1f, normalizeAmplitude(32_767), 0.0001f)
        assertEquals(1f, normalizeAmplitude(65_534), 0.0001f)
    }

    @Test
    fun negativePlatformAmplitudeIsRejected() {
        assertThrows(IllegalArgumentException::class.java) {
            normalizeAmplitude(-1)
        }
    }
}
