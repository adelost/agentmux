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
        val options = linkRecipientOptions(model)
        assertEquals("a", model.selectedTargetId)
        assertEquals(listOf("a", "b"), options.map { it.id })
        assertTrue(options.first().enabled)
        assertFalse("config labels leaked into TALK TO", options.any { "Same name" in it.detail })
        assertFalse("the check already marks selection", options.first().detail.contains("TALKING TO NOW"))
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

        assertTrue(details.getValue("a").contains("gpt-5.6-sol · xhigh"))
        assertFalse(details.getValue("a").contains("OBSERVED"))
        assertTrue(details.getValue("a").contains("Configured · gpt-6-astra · max"))
        assertTrue(details.getValue("b").contains("claude-fable-5 · Last seen"))
        assertTrue(details.getValue("c").contains("Model unknown"))
        assertTrue(details.getValue("c").contains("Configured · claude-opus-4-8"))
    }

    @Test fun identicalCurrentConfigurationDoesNotRepeatTheModel() {
        val target = LinkTarget(
            "lsrc:4",
            "Internal worker description",
            model = LinkTargetModel(
                status = LinkTargetModelStatus.CURRENT,
                observedModel = "gpt-5.6-sol",
                observedEffort = "xhigh",
                configuredModel = "gpt-5.6-sol",
                configuredEffort = "xhigh",
            ),
        )

        assertEquals(listOf("gpt-5.6-sol · xhigh"), linkTargetModelLines(target))
        assertEquals("gpt-5.6-sol · xhigh", linkRecipientRow(
            LinkState(targets = listOf(target), selectedTargetId = target.id).toTargetPresentation { null },
        ) {}.sub)
    }

    @Test fun selectedFavoritesDirectTargetsAndWindowGroupsKeepEveryStableIdOnce() {
        val targets = listOf(
            LinkTarget("windows", "Windows rescue"),
            LinkTarget("lsrc:3", "Previous worker"),
            LinkTarget("lsrc:4", "Astra orchestrator"),
            LinkTarget("lsrc:4", "Duplicate transport row"),
            LinkTarget("lsrc:5", "Self-directed fleet"),
            LinkTarget("skyvw:3", "PAUSED on PR"),
            LinkTarget("skyvw:4", "Another internal description"),
        )
        val presentation = LinkState(targets = targets, selectedTargetId = "lsrc:4")
            .toTargetPresentation { null }

        val menu = linkRecipientMenu(presentation, favoriteIds = setOf("lsrc:4", "lsrc:5"))

        assertEquals(listOf("lsrc:4", "lsrc:5", "windows"), menu.directTargets.map(LinkTarget::id))
        assertEquals(listOf("lsrc", "skyvw"), menu.groups.map(LinkRecipientGroup::windowId))
        assertEquals(listOf("lsrc:3"), menu.groups.first().targets.map(LinkTarget::id))
        assertEquals(listOf("skyvw:3", "skyvw:4"), menu.groups.last().targets.map(LinkTarget::id))
        assertEquals(
            setOf("windows", "lsrc:3", "lsrc:4", "lsrc:5", "skyvw:3", "skyvw:4"),
            (menu.directTargets + menu.groups.flatMap(LinkRecipientGroup::targets)).map(LinkTarget::id).toSet(),
        )
    }
}
