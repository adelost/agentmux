package io.agentmux.linkui

import io.agentmux.linkui.product.LinkProductSession
import io.agentmux.linkui.product.generated.LinkArtifactProfile
import io.agentmux.linkui.product.generated.LinkMenuAction
import io.agentmux.linkui.product.generated.LinkRoute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Test

class LinkMenuActionsTest {
    @Test
    fun settingsActionProjectsToPhoneAndWearAndDispatchesByTypedId() {
        val product = LinkProductSession(LinkArtifactProfile.PHONE_FULL_UI)
        val actions = mutableListOf<LinkMenuAction>()
        val phone = linkSettingsHeaderAction(product, actions::add)
        val wear = linkSettingsRow(product, actions::add)

        assertEquals("SETTINGS", phone.label)
        assertEquals("SETTINGS", wear.title)
        assertEquals("CONNECTION & AUDIO", wear.sub)
        assertEquals("Open Link settings", phone.contentDescription)
        assertSame(phone.icon, wear.icon)
        phone.onTap()
        assertNotNull(wear.onTap)
        wear.onTap?.invoke()
        assertEquals(
            listOf(LinkMenuAction.OPEN_SETTINGS, LinkMenuAction.OPEN_SETTINGS),
            actions,
        )

        var route = LinkRoute.HOME
        actions.first().dispatch(product) { route = it }
        assertEquals(LinkRoute.SETTINGS, route)
    }
}
