package io.agentmux.linkcore

/**
 * Closes one recorder exactly once even when stop fails.
 *
 * The generic seam keeps the failure contract unit-testable without an
 * Android MediaRecorder instance.
 */
object RecorderFinalizer {
    fun <T> finish(
        recorder: T,
        stop: (T) -> Unit,
        release: (T) -> Unit,
        hasPayload: () -> Boolean,
    ): Boolean = try {
        stop(recorder)
        hasPayload()
    } catch (_: RuntimeException) {
        false
    } finally {
        runCatching { release(recorder) }
    }
}
