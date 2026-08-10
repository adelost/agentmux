package io.agentmux.linkui.product

import io.agentmux.linkui.product.generated.GeneratedLinkArtifactRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class LinkNavigationControllerTest {
    @Test
    fun phoneUsesRegisteredEntryAndPreviousStack() {
        val navigation = LinkNavigationController(GeneratedLinkArtifactRef.PHONE_FULL_UI)

        assertEquals(LinkRoute.HOME, navigation.route.value)
        assertFalse(navigation.back())

        navigation.open(LinkRoute.SETTINGS)
        navigation.open(LinkRoute.DEV_HOST)
        assertTrue(navigation.back())
        assertEquals(LinkRoute.SETTINGS, navigation.route.value)
        assertTrue(navigation.back())
        assertEquals(LinkRoute.HOME, navigation.route.value)
    }

    @Test
    fun artifactSubsetRejectsPageOutsideWear() {
        val navigation = LinkNavigationController(GeneratedLinkArtifactRef.WEAR_FULL_UI)

        assertThrows(IllegalArgumentException::class.java) {
            navigation.open(LinkRoute.DEV_HOST)
        }
        assertEquals(LinkRoute.HOME, navigation.route.value)
    }

    @Test
    fun restoredDevHostKeepsItsRegisteredPreviousPage() {
        val navigation = LinkNavigationController(
            artifact = GeneratedLinkArtifactRef.PHONE_FULL_UI,
            initial = LinkRoute.DEV_HOST,
            initialPrevious = LinkRoute.SETTINGS,
        )

        assertTrue(navigation.back())
        assertEquals(LinkRoute.SETTINGS, navigation.route.value)
    }
}
