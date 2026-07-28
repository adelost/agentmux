package io.agentmux.audioinbox

import io.agentmux.linkcore.LinkTarget
import org.junit.Assert.assertEquals
import org.junit.Test

class LinkPhoneProjectionTest {
    @Test
    fun duplicateAgentLabelsRemainDistinctAndRouteByStableId() {
        assertEquals(
            listOf(
                "one" to "SKYVW · ONE",
                "two" to "SKYVW · TWO",
            ),
            targetChoices(
                listOf(
                    LinkTarget(id = "one", label = "Skyvw"),
                    LinkTarget(id = "two", label = "Skyvw"),
                ),
            ),
        )
    }

    @Test
    fun uniqueAgentLabelsStayConcise() {
        assertEquals(
            listOf(
                "skyvw:3" to "SKYVW 3",
                "skyvw:9" to "SKYVW 9",
            ),
            targetChoices(
                listOf(
                    LinkTarget(id = "skyvw:3", label = "Skyvw 3"),
                    LinkTarget(id = "skyvw:9", label = "Skyvw 9"),
                ),
            ),
        )
    }
}
