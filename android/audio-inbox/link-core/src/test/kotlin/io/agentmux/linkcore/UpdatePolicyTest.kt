package io.agentmux.linkcore

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatePolicyTest {
    @Test
    fun `both version code and semantic name must increase`() {
        assertTrue(UpdatePolicy.isStrictUpgrade(1, "1.0.0", 2, "1.1.0"))
        assertFalse(UpdatePolicy.isStrictUpgrade(2, "1.1.0", 2, "1.2.0"))
        assertFalse(UpdatePolicy.isStrictUpgrade(2, "1.1.0", 3, "1.0.9"))
        assertFalse(UpdatePolicy.isStrictUpgrade(1, "preview", 2, "1.1.0"))
    }
}
