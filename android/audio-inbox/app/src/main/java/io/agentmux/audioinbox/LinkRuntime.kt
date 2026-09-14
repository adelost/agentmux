package io.agentmux.audioinbox

import android.content.Context

/**
 * WHAT: Process-wide leases on the one LinkCoordinator.
 * WHY: The phone UI and the wake word service share one conversation owner, so a
 * question asked with the screen locked lands in the same history and ledger.
 * The coordinator closes when the last holder releases it, as it did with the Activity.
 */
internal object LinkRuntime {
    private var coordinator: LinkCoordinator? = null
    private var leases = 0

    @Synchronized
    fun acquire(context: Context): LinkCoordinator {
        leases += 1
        return coordinator ?: LinkCoordinator(context.applicationContext).also { coordinator = it }
    }

    @Synchronized
    fun release(held: LinkCoordinator) {
        check(coordinator === held && leases > 0) { "Released a coordinator this process does not lease" }
        leases -= 1
        if (leases == 0) {
            held.close()
            coordinator = null
        }
    }
}
