package io.agentmux.linkui

import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkui.product.toTargetPresentation
import org.junit.Assert.*
import org.junit.Test

class LinkRecipientTest {
    @Test fun offlineSelectionCannotSilentlyDisplayAnotherRecipient() {
        val state = LinkState(
            targets = listOf(LinkTarget("a", "Same name", false, true), LinkTarget("b", "Same name")),
            selectedTargetId = "a",
        )
        val model = state.toTargetPresentation { null }
        assertEquals("a", model.selectedTargetId)
        assertEquals(listOf("a", "b"), linkRecipientOptions(model).map { it.id })
        assertTrue(linkRecipientOptions(model).first().enabled)
        assertEquals("TO a", linkRecipientRow(model) {}.title)
    }

    @Test fun selectionOpensAnExplicitListAndDoesNotCycle() {
        var opened = false
        val model = LinkState(targets = listOf(LinkTarget("a", "A"))).toTargetPresentation { null }
        val row = linkRecipientRow(model) { opened = true }
        row.onTap!!.invoke()
        assertTrue(opened)
        assertTrue(row.choices.isEmpty())
        assertNull(row.onSelect)
    }
}
