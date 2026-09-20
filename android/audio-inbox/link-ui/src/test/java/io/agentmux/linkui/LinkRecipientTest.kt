package io.agentmux.linkui

import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkcore.LinkTargetModel
import io.agentmux.linkcore.LinkTargetModelStatus
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

    @Test fun observedConfiguredStaleAndUnknownModelsStayDistinct() {
        val current = LinkTarget(
            "a",
            "Worker",
            model = LinkTargetModel(
                status = LinkTargetModelStatus.CURRENT,
                observedModel = "gpt-5.6-sol",
                observedEffort = "xhigh",
                configuredModel = "gpt-6-astra",
                configuredEffort = "max",
            ),
        )
        val stale = LinkTarget(
            "b",
            "Worker two",
            model = LinkTargetModel(
                status = LinkTargetModelStatus.STALE,
                observedModel = "claude-fable-5",
            ),
        )
        val unknown = LinkTarget(
            "c",
            "Worker three",
            model = LinkTargetModel(
                configuredModel = "claude-opus-4-8",
            ),
        )
        val model = LinkState(targets = listOf(current, stale, unknown), selectedTargetId = "a")
            .toTargetPresentation { null }

        val details = linkRecipientOptions(model).associate { it.id to it.detail }

        assertTrue(details.getValue("a").contains("gpt-5.6-sol · xhigh · OBSERVED"))
        assertTrue(details.getValue("a").contains("gpt-6-astra · max · CONFIGURED"))
        assertTrue(details.getValue("b").contains("claude-fable-5 · STALE"))
        assertTrue(details.getValue("c").contains("MODEL UNKNOWN"))
        assertTrue(details.getValue("c").contains("claude-opus-4-8 · CONFIGURED"))
    }
}
