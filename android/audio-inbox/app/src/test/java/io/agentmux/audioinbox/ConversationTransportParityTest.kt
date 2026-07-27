package io.agentmux.audioinbox

import io.agentmux.linkcore.LinkAction
import io.agentmux.linkcore.LinkReducer
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTurn
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class ConversationTransportParityTest {
    @Test
    fun `tailnet and fake public adapters produce the same conversation state`() {
        assertEquals(runAdapter("tailnet"), runAdapter("public-fake"))
    }

    private fun runAdapter(id: String): LinkState {
        var state = LinkReducer.reduce(
            LinkState(),
            LinkAction.Submit(
                LinkTurn("turn-1", "lsrc:3", "L-source 3", "Hej", createdAtMs = 1),
            ),
        )
        val replied = CountDownLatch(1)
        val transport = object : ConversationTransport {
            override fun transportId() = id
            override fun supports(target: ConversationTarget) = true
            override fun durableAccept(
                turnId: String,
                target: ConversationTarget,
                text: String?,
                audio: File?,
            ) = ConversationTransport.Accepted("Hej", turnId, "cursor")

            override fun awaitReply(
                turnId: String,
                target: ConversationTarget,
                accepted: ConversationTransport.Accepted,
            ) = ConversationTransport.Reply("lsrc:3", "Svar")
        }
        val controller = ConversationController(
            Runnable::run,
            listOf(transport),
            object : ConversationController.Listener {
                override fun onSending(
                    turnId: String,
                    target: ConversationTarget,
                    draft: String,
                ) = Unit

                override fun onAccepted(
                    turnId: String,
                    target: ConversationTarget,
                    visibleText: String,
                ) {
                    state = LinkReducer.reduce(state, LinkAction.Accepted(turnId, visibleText))
                }

                override fun onReply(
                    turnId: String,
                    target: ConversationTarget,
                    respondingTarget: String,
                    text: String,
                ) {
                    state = LinkReducer.reduce(
                        state,
                        LinkAction.Reply(turnId, respondingTarget, text, receivedAtMs = 2),
                    )
                    replied.countDown()
                }

                override fun onDeliveryFailure(
                    turnId: String,
                    target: ConversationTarget,
                    message: String,
                ) = Unit

                override fun onReplyFailure(
                    turnId: String,
                    target: ConversationTarget,
                    message: String,
                ) = Unit
            },
        )
        val target = ConversationTarget(
            "lsrc:3",
            "L-source 3",
            ConversationTarget.Kind.AGENT,
            "http://127.0.0.1",
            "1234567890",
            "lsrc",
            3,
        )

        assertTrue(controller.sendText(target, "Hej", "turn-1"))
        assertTrue(replied.await(2, TimeUnit.SECONDS))
        controller.close()
        return state
    }
}
