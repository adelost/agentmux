package io.agentmux.linkui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Test

class LinkMenuActionsTest {
    @Test
    fun settingsActionProjectsToPhoneAndWearAndDispatchesByTypedId() {
        val actions = mutableListOf<LinkMenuAction>()
        val phone = linkSettingsHeaderAction(actions::add)
        val wear = linkSettingsRow(actions::add)

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

        var opened = false
        actions.first().dispatch { opened = true }
        assertEquals(true, opened)
    }
}
