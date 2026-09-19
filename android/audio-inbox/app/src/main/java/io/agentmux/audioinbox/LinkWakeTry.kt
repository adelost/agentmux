package io.agentmux.audioinbox

import android.content.Context
import android.content.Intent
import io.agentmux.wakeword.WakeChunkTrace
import io.agentmux.wakeword.WakeChunkTraceFanout
import io.agentmux.wakeword.WakePhrase
import io.agentmux.wakeword.WakeTryRecorder
import io.agentmux.wakeword.WakeTryTrace
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * WHAT: Whether the TRY page is on screen, and the recorder the microphone loop reports to while it is.
 * WHY: Row 217. On the TRY page a wake is judged and shown and never acted on: no question is captured,
 * nothing is sent and no reply is read. That rule belongs to the host rather than to the page, because
 * what must not happen is a question starting, and the question starts in the service. The page only
 * opens and closes this; the service reads it on the microphone thread.
 *
 * The recorder is new for every visit: LAST TRIES is five tries in memory and a page nobody is looking
 * at keeps nothing.
 */
internal object LinkWakeTry {
    private val mutableOpen = MutableStateFlow(false)
    val open: StateFlow<Boolean> = mutableOpen.asStateFlow()

    /** Null unless the page is open; the loop reads it when it opens and reports every chunk to it. */
    @Volatile
    var recorder: WakeTryRecorder? = null
        private set

    /** The page is on screen. The loop reopens with the recorder attached, and starts if it was off. */
    fun opened(context: Context, phrase: WakePhrase) {
        recorder = WakeTryRecorder(phrase)
        mutableOpen.value = true
        context.startForegroundService(wakeService(context, WakeWordService.ACTION_TRY_OPEN))
    }

    /** The page is gone. The loop goes back to what it was doing before it opened: listening, or off. */
    fun closed(context: Context) {
        mutableOpen.value = false
        recorder = null
        context.startService(wakeService(context, WakeWordService.ACTION_TRY_CLOSE))
    }

    fun read(): WakeTryTrace = recorder?.read() ?: WakeTryTrace()

    private fun wakeService(context: Context, action: String) =
        Intent(context, WakeWordService::class.java).setAction(action)
}

/**
 * Who is listening in on the microphone loop: the TRY page while it is open, WAKE DEBUG while it is
 * watching, both at once when both are, and nobody at all otherwise, which is the normal case and is why
 * the loop asks the speech model nothing while it waits.
 */
internal fun wakeChunkWatchers(): WakeChunkTrace? {
    val watchers = listOfNotNull(
        LinkWakeTry.recorder,
        LinkWakeDebug.trace.takeIf { LinkWakeDebug.watching.value },
    )
    return when (watchers.size) {
        0 -> null
        1 -> watchers.single()
        else -> WakeChunkTraceFanout(watchers)
    }
}
