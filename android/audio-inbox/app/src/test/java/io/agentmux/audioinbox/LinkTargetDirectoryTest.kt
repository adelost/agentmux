package io.agentmux.audioinbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class LinkTargetDirectoryTest {
    @Test
    fun `directory prefers private route and applies stable favorite order`() {
        val directory = LinkTargetDirectory()
        val privateLsrc10 = privateTarget("lsrc:10")
        val privateOther = privateTarget("skyvw:4")
        directory.addTailnet(listOf(privateOther, privateLsrc10))
        directory.replacePublic(
            listOf(
                ConversationTarget.publicLink("lsrc:10", "Public 10", true),
                ConversationTarget.publicLink("lsrc:3", "Public 3", true),
            ),
        )

        val rebuilt = directory.rebuild()

        assertEquals(listOf("lsrc:3", "lsrc:10", "skyvw:4"), rebuilt.map { it.id })
        assertSame(privateLsrc10, directory.target("lsrc:10"))
    }

    @Test
    fun `clearing public routes preserves private directory`() {
        val directory = LinkTargetDirectory()
        val private = privateTarget("skyvw:3")
        directory.addTailnet(listOf(private))
        directory.replacePublic(
            listOf(ConversationTarget.publicLink("lsrc:3", "Public 3", true)),
        )
        directory.rebuild()

        directory.clearPublic()
        val rebuilt = directory.rebuild()

        assertEquals(listOf("skyvw:3"), rebuilt.map { it.id })
        assertSame(private, directory.target("skyvw:3"))
    }

    private fun privateTarget(id: String) = ConversationTarget(
        id,
        id,
        ConversationTarget.Kind.AGENT,
        "https://abyss-wsl.tail13cb13.ts.net:8443",
        "1234567890",
        id.substringBefore(":"),
        id.substringAfter(":").toInt(),
    )
}
