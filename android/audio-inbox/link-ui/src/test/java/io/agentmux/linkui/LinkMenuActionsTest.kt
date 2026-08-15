package io.agentmux.linkui

import io.agentmux.linkui.product.LinkRoute
import io.agentmux.linkui.product.LinkNativeBindings
import io.agentmux.linkui.product.generated.GeneratedLinkChromeActions
import io.agentmux.linkui.product.generated.GeneratedLinkRoutes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Test

class LinkMenuActionsTest {
    /**
     * The old version of this test asserted the settings labels as literals and
     * dispatched through LinkProductSession/LinkMenuAction. That mechanism is
     * deleted, and re-asserting literals would only prove that two hand-written
     * copies still agree -- which is the defect, not the property.
     *
     * What survives is the claim worth keeping: phone chrome and the wear row
     * are the SAME declared affordance, so they cannot drift apart.
     */
    @Test
    fun phoneChromeAndWearRowRenderTheSameDeclaredAction() {
        var opened = 0
        val phone = linkSettingsHeaderAction { opened++ }
        val wear = linkSettingsRow { opened++ }
        val declared = GeneratedLinkChromeActions.OPEN_SETTINGS

        assertEquals(declared.title, phone.label)
        assertEquals(declared.title, wear.title)
        assertEquals(declared.detail, wear.sub)
        assertEquals(declared.a11y, phone.contentDescription)
        assertEquals(declared.rowKey, wear.key)
        assertSame(phone.icon, wear.icon)

        phone.onTap()
        assertNotNull(wear.onTap)
        wear.onTap?.invoke()
        assertEquals(2, opened)
    }

    /**
     * Route identity comes from the declaration, not from Kotlin. The `when` in
     * GeneratedLinkRoutes is exhaustive, so a route added to the enum without a
     * declaration cannot compile -- this test only has to prove the values
     * actually arrive.
     */
    @Test
    fun everyRouteCarriesDeclaredIdentity() {
        LinkRoute.entries.forEach { route ->
            val descriptor = GeneratedLinkRoutes.descriptor(route)
            assertEquals(route, descriptor.route)
            assertNotNull(LinkNativeBindings.requireIcon(descriptor.iconAssetRef))
            assertNotNull(descriptor.title)
            assertEquals(descriptor.title, descriptor.title.trim())
        }
    }
}
