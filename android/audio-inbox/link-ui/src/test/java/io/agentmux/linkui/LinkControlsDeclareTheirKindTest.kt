package io.agentmux.linkui

import com.adelost.designkit.ui.CircleActionTiming
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.ReplyPhase
import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkui.product.toHistoryPresentation
import io.agentmux.linkui.product.toTargetPresentation
import io.agentmux.linkui.product.generated.GeneratedLinkControlTiming
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * Every Link control that can be pressed says which kind of button it is, and says it once.
 *
 * Row 225. Mattias pressed SETTINGS · WAKE PHRASE for a millisecond and it switched while the row
 * drew a half-second arc: "det ska inte finnas något mellanting liksom, bara de här två typerna utav
 * knappar". Link had nothing written down about any of its controls. LinkInteractionHost provided
 * IMMEDIATE for every ordinary tap in the app, one sentence overriding every control at once, and a
 * row's own drawing never saw it.
 *
 * WHY A CASE AND NOT JUST THE DECLARATION: with the override gone, a row that names no kind takes
 * RowSpec's default, which is DELIBERATE. So forgetting one does not leave it as it was; it puts an
 * invisible half-second gate on it. These cases read the kind off the rows the app actually builds.
 */
class LinkControlsDeclareTheirKindTest {

    @Test fun theRecipientRowsAreTouches() {
        val state = LinkState(targets = listOf(LinkTarget("lsrc:0", "lsrc:0")), selectedTargetId = "lsrc:0")
        val row = linkRecipientRow(state.toTargetPresentation { null }) {}
        assertEquals(
            "opening the recipient picker asks for a held press",
            GeneratedLinkControlTiming.HOME_RECIPIENT,
            row.actionTiming,
        )
        assertEquals("the declaration says the picker is a touch", CircleActionTiming.IMMEDIATE, row.actionTiming)
    }

    @Test fun clearingAConversationIsTheOneHold() {
        // The rule's other half, on the one Link control that destroys something: clearing is not
        // taken back by a second press, so it is the only control in the app that waits. Read off
        // the row the app builds, because a constant nobody reads is not a declaration.
        val state = LinkState(
            targets = listOf(LinkTarget("lsrc:0", "lsrc:0")),
            selectedTargetId = "lsrc:0",
            turns = listOf(
                LinkTurn("a", "lsrc:0", "lsrc:0", "a", createdAtMs = 1, deliveryPhase = DeliveryPhase.QUEUED, replyPhase = ReplyPhase.READY),
            ),
        )
        val row = requireNotNull(linkClearConversationRow(state.toHistoryPresentation(), icon = null) {})

        assertEquals("CLEAR stopped being the control that waits", CircleActionTiming.DELIBERATE, row.actionTiming)
        assertEquals("and it no longer says so from the product's declaration", GeneratedLinkControlTiming.HISTORY_CLEAR, row.actionTiming)
    }

    @Test fun everyOtherDeclaredControlIsATouch() {
        // Derived from the rule rather than listed by hand: Link navigates, chooses and toggles, and
        // destroys exactly one thing. A new control that waits has to be argued for, and this case is
        // where the argument lands.
        val holds = declaredKinds().filterValues { it == CircleActionTiming.DELIBERATE }
        assertEquals(
            "a control started asking for a held press without the rule being applied to it",
            setOf("HISTORY_CLEAR"),
            holds.keys,
        )
    }

    @Test fun pushToTalkDeclaresNoKindAtAll() {
        // product-spec says it beside the two words: a gesture whose duration IS the content is
        // neither kind. A constant for it would be the third kind by another name.
        assertEquals(
            "push-to-talk was given a kind, which promises a gate its release does not have",
            emptyList<String>(),
            declaredKinds().keys.filter { it.contains("PUSH") || it.contains("TALK") },
        )
    }

    @Test fun theDeclarationCoversWhatTheAppPresses() {
        // A constant nobody reads is a declaration that has stopped being the truth. These are the
        // controls whose rows a pure function builds, so the case can hold them to it.
        assertNotNull(GeneratedLinkControlTiming.SETTINGS_WAKE_PHRASE)
        assertNotNull(GeneratedLinkControlTiming.SETTINGS_PUBLIC_LINK)
        assertNotNull(GeneratedLinkControlTiming.HOME_VOICE_MESSAGE)
        assertNotNull(GeneratedLinkControlTiming.CONVERSATION_PLAY_TURN)
    }

    private fun declaredKinds(): Map<String, CircleActionTiming> =
        GeneratedLinkControlTiming::class.java.declaredFields
            .filter { it.type == CircleActionTiming::class.java }
            .associate { field ->
                field.isAccessible = true
                field.name to field.get(GeneratedLinkControlTiming) as CircleActionTiming
            }
}
