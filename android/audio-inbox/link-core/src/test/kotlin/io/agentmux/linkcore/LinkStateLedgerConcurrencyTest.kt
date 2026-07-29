package io.agentmux.linkcore
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class LinkStateLedgerConcurrencyTest {
    @Test
    fun `concurrent target discovery and reply preserve both transitions and persistence`() {
        val persisted = CopyOnWriteArrayList<LinkState>()
        val initial = LinkState(
            turns = listOf(
                LinkTurn(
                    turnId = "turn-a",
                    targetId = "lsrc:3",
                    targetLabel = "lsrc:3",
                    userText = "Hej",
                    createdAtMs = 1,
                    deliveryPhase = DeliveryPhase.QUEUED,
                    replyPhase = ReplyPhase.THINKING,
                ),
            ),
        )
        val workers = Executors.newFixedThreadPool(2)
        repeat(100) {
            val ledger = LinkStateLedger(initial, persisted::add)
            val start = CountDownLatch(1)
            val done = CountDownLatch(2)
            workers.execute {
                start.await()
                ledger.dispatch(LinkAction.Targets(listOf(LinkTarget("lsrc:3", "L-source 3"))))
                done.countDown()
            }
            workers.execute {
                start.await()
                ledger.dispatch(LinkAction.Reply("turn-a", "lsrc:3", "Svar"))
                done.countDown()
            }
            start.countDown()

            check(done.await(2, TimeUnit.SECONDS))
            assertEquals(listOf("lsrc:3"), ledger.value.targets.map { target -> target.id })
            assertEquals("Svar", ledger.value.turns.single().replyText)
            assertEquals(ReplyPhase.READY, ledger.value.turns.single().replyPhase)
            assertEquals(ledger.value, persisted.last())
        }
        workers.shutdownNow()
    }
}
