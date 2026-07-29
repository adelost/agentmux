package io.agentmux.audioinbox.wear

import io.agentmux.audioinbox.LinkSessionCredentials
import io.agentmux.audioinbox.LinkSessionStore
import io.agentmux.audioinbox.LinkWearSessionPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WearSessionHandoffConsumerTest {
    @Test
    fun activeThenRevokePersistsAndClearsTheSameStore() {
        val store = FakeStore()
        val consumer = WearSessionHandoffConsumer(store)
        val credentials = LinkSessionCredentials(
            "https://link.v1d.io",
            "session-one",
            "identity-one",
        )

        assertEquals(
            HandoffResult.STORED,
            consumer.accept(LinkWearSessionPayload.active(credentials, 42L).encode()),
        )
        assertEquals("session-one", store.session())
        assertEquals("identity-one", store.identityId())

        assertEquals(
            HandoffResult.REVOKED,
            consumer.accept(LinkWearSessionPayload.revoked(43L).encode()),
        )
        assertNull(store.session())
    }

    @Test
    fun malformedPayloadNeverMutatesTheOldSession() {
        val store = FakeStore().apply {
            replaceSession(
                LinkSessionCredentials("https://link.v1d.io", "old", "identity"),
            )
        }

        assertEquals(
            HandoffResult.REFUSED,
            WearSessionHandoffConsumer(store).accept(mapOf("version" to "999")),
        )
        assertEquals("old", store.session())
    }

    private class FakeStore : LinkSessionStore {
        private var current: LinkSessionCredentials? = null

        override fun baseUrl(): String =
            current?.baseUrl() ?: "https://link.v1d.io"

        override fun session(): String? = current?.session()
        override fun identityId(): String = current?.identityId().orEmpty()
        override fun pendingVerifier(): String? = null
        override fun replacePendingVerifier(verifier: String?) = false
        override fun saveSessionAndClearPending(
            credentials: LinkSessionCredentials?,
            expectedVerifier: String?,
        ) = false

        override fun replaceSession(credentials: LinkSessionCredentials): Boolean {
            current = credentials
            return true
        }

        override fun clear() {
            current = null
        }
    }
}
