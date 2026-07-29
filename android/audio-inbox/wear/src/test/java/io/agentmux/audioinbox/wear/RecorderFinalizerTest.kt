package io.agentmux.audioinbox.wear

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RecorderFinalizerTest {
    @Test
    fun `throwing stop still releases and leaves the next recorder usable`() {
        val broken = FakeRecorder(throwOnStop = true)

        val valid = finish(broken)
        val next = FakeRecorder(throwOnStop = false)
        val nextValid = finish(next)

        assertFalse(valid)
        assertTrue(broken.released)
        assertTrue(nextValid)
        assertTrue(next.released)
    }

    private fun finish(recorder: FakeRecorder): Boolean = RecorderFinalizer.finish(
        recorder = recorder,
        stop = FakeRecorder::stop,
        release = FakeRecorder::release,
        hasPayload = { true },
    )

    private class FakeRecorder(
        private val throwOnStop: Boolean,
    ) {
        var released = false

        fun stop() {
            if (throwOnStop) throw IllegalStateException("stop failed")
        }

        fun release() {
            released = true
        }
    }
}
