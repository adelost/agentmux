package io.agentmux.linkcore

/**
 * WHAT: Maps public voice byte usage to a visible non-cancelling upload warning.
 * WHY: Keeps transport cost bounds from becoming a hidden recording duration limit.
 */
object VoiceUploadPolicy {
    const val PUBLIC_MAX_BYTES: Long = 5L * 1024 * 1024
    const val WARNING_BYTES: Long = PUBLIC_MAX_BYTES * 4 / 5
    const val OVER_LIMIT_MESSAGE =
        "Public voice upload exceeds 5 MB; recording continued until release"

    fun warning(recordedBytes: Long, limitBytes: Long?): String? {
        if (limitBytes == null || recordedBytes < limitBytes * 4 / 5) return null
        return if (recordedBytes > limitBytes) {
            "Over 5 MB · release to finish; send will fail without truncation"
        } else {
            "Approaching the 5 MB Public Link upload limit"
        }
    }
}
