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
    fun `offline public route wins because it can queue while private route cannot`() {
        val tailnet = privateTarget(serverUrl = "ftp://offline.invalid")
        val publicLink = ConversationTarget.publicLink("skyvw:3", "Skyvw 3", false)

        assertSame(publicLink, LinkTargetRoutePolicy.choose(tailnet, publicLink))
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

    private fun privateTarget(
        serverUrl: String = "https://abyss-wsl.tail13cb13.ts.net:8443",
    ) = ConversationTarget(
        "skyvw:3",
        "Skyvw 3",
        ConversationTarget.Kind.AGENT,
        serverUrl,
        "1234567890",
        "skyvw",
        3,
    )
}
