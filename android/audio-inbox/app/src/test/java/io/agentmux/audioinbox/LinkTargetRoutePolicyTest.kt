package io.agentmux.audioinbox

import org.junit.Assert.assertSame
import org.junit.Test

class LinkTargetRoutePolicyTest {
    @Test
    fun `private tailnet wins when both routes are available`() {
        val tailnet = privateTarget()
        val publicLink = ConversationTarget.publicLink("skyvw:3", "Skyvw 3", true)

        assertSame(tailnet, LinkTargetRoutePolicy.choose(tailnet, publicLink))
    }

    @Test
    fun `public link is the fallback when private route is unavailable`() {
        val publicLink = ConversationTarget.publicLink("skyvw:3", "Skyvw 3", true)

        assertSame(publicLink, LinkTargetRoutePolicy.choose(null, publicLink))
    }

    @Test
    fun `known private route remains visible while temporarily unavailable`() {
        val tailnet = privateTarget()
        val publicLink = ConversationTarget.publicLink("skyvw:3", "Skyvw 3", false)

        assertSame(tailnet, LinkTargetRoutePolicy.choose(tailnet, publicLink))
    }

    @Test
    fun `connection copy tells the truth when public is only a fallback`() {
        org.junit.Assert.assertEquals(
            "Connected via Tailscale · Public fallback ready",
            LinkTargetRoutePolicy.connectionDetail(
                hasTailnetRoute = true,
                hasPublicFallback = true,
            ),
        )
    }

    private fun privateTarget() = ConversationTarget(
        "skyvw:3",
        "Skyvw 3",
        ConversationTarget.Kind.AGENT,
        "https://abyss-wsl.tail13cb13.ts.net:8443",
        "1234567890",
        "skyvw",
        3,
    )
}
