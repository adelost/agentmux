package io.agentmux.linkui

import org.junit.Assert.assertEquals
import org.junit.Test

class LinkCaptureAvailabilityTest {
    @Test
    fun microphoneAndDeliveryFailuresAreNeverSilent() {
        assertEquals(
            LinkCaptureAvailability.Recoverable("ENABLE MIC", "MICROPHONE PERMISSION"),
            resolveLinkCaptureAvailability(true, true, microphoneGranted = false, finalizing = false),
        )
        assertEquals(
            LinkCaptureAvailability.Blocked("NO TARGET", "SELECT AGENT"),
            resolveLinkCaptureAvailability(false, false, microphoneGranted = true, finalizing = false),
        )
        assertEquals(
            LinkCaptureAvailability.Blocked("UNAVAILABLE", "NO DELIVERY ROUTE"),
            resolveLinkCaptureAvailability(true, false, microphoneGranted = true, finalizing = false),
        )
    }

    @Test
    fun knownSendableTargetIsReadyEvenWhenPresenceIsTrackedSeparately() {
        assertEquals(
            LinkCaptureAvailability.Ready,
            resolveLinkCaptureAvailability(true, true, microphoneGranted = true, finalizing = false),
        )
    }
}
