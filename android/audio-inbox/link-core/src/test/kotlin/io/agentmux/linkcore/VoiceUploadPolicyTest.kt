package io.agentmux.linkcore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceUploadPolicyTest {
    @Test
    fun `byte warning never imposes a recording duration or silent truncation`() {
        assertNull(VoiceUploadPolicy.warning(VoiceUploadPolicy.WARNING_BYTES - 1, null))
        assertNull(
            VoiceUploadPolicy.warning(
                VoiceUploadPolicy.WARNING_BYTES - 1,
                VoiceUploadPolicy.PUBLIC_MAX_BYTES,
            ),
        )
        assertTrue(
            VoiceUploadPolicy.warning(
                VoiceUploadPolicy.WARNING_BYTES,
                VoiceUploadPolicy.PUBLIC_MAX_BYTES,
            )!!.contains("Approaching"),
        )
        assertEquals(
            "Over 5 MB · release to finish; send will fail without truncation",
            VoiceUploadPolicy.warning(
                VoiceUploadPolicy.PUBLIC_MAX_BYTES + 1,
                VoiceUploadPolicy.PUBLIC_MAX_BYTES,
            ),
        )
    }
}
