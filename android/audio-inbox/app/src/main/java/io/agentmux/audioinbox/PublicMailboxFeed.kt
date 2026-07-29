package io.agentmux.audioinbox

import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** Bounded mailbox poller; UI state remains owned by the shared reducer. */
internal class PublicMailboxFeed(
    private val sessions: LinkSessionStore,
    private val onPage: (PublicLinkClient.EventsPage) -> Unit,
) : AutoCloseable {
    private val work = Executors.newSingleThreadScheduledExecutor()
    private var future: ScheduledFuture<*>? = null
    private var afterSeq = 0L
    private var sessionFingerprint = ""

    fun start() {
        if (future != null) return
        future = work.scheduleWithFixedDelay(::poll, 0, 2, TimeUnit.SECONDS)
    }

    private fun poll() {
        val credentials = sessions.credentials() ?: return
        val fingerprint = credentials.session().takeLast(12)
        if (fingerprint != sessionFingerprint) {
            afterSeq = 0
            sessionFingerprint = fingerprint
        }
        runCatching {
            PublicLinkClient(credentials.baseUrl(), credentials.session()).events(afterSeq)
        }.onSuccess { page ->
            page.events.forEach { afterSeq = maxOf(afterSeq, it.seq) }
            onPage(page)
        }
    }

    override fun close() {
        future?.cancel(true)
        work.shutdownNow()
    }
}
