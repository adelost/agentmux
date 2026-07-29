package io.agentmux.audioinbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class LinkTargetDirectoryTest {
    @Test
    fun `directory prefers private route and preserves server catalog order`() {
        val directory = LinkTargetDirectory()
        val privateBeta = privateTarget("beta:2")
        val privateAlpha = privateTarget("alpha:1")
        directory.addTailnet(listOf(privateBeta, privateAlpha))
        directory.replacePublic(
            listOf(
                ConversationTarget.publicLink("alpha:1", "Public alpha", true),
                ConversationTarget.publicLink("gamma:3", "Public gamma", true),
            ),
        )

        val rebuilt = directory.rebuild()

        assertEquals(listOf("beta:2", "alpha:1", "gamma:3"), rebuilt.map { it.id })
        assertSame(privateAlpha, directory.target("alpha:1"))
    }

    @Test
    fun `clearing public routes preserves private directory`() {
        val directory = LinkTargetDirectory()
        val private = privateTarget("alpha:1")
        directory.addTailnet(listOf(private))
        directory.replacePublic(
            listOf(ConversationTarget.publicLink("beta:2", "Public beta", true)),
        )
        directory.rebuild()

        directory.clearPublic()
        val rebuilt = directory.rebuild()

        assertEquals(listOf("alpha:1"), rebuilt.map { it.id })
        assertSame(private, directory.target("alpha:1"))
    }

    private fun privateTarget(id: String) = ConversationTarget(
        id,
        id,
        ConversationTarget.Kind.AGENT,
        "https://relay.example.ts.net:8443",
        "1234567890",
        id.substringBefore(":"),
        id.substringAfter(":").toInt(),
    )
}
