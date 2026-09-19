package io.agentmux.audioinbox

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.adelost.ringkit.ui.PhoneScreenHeader
import io.agentmux.linkui.product.LinkNativeBindings
import io.agentmux.linkui.product.LinkRoute
import io.agentmux.linkui.product.wakeSensitivityWord
import io.agentmux.linkui.product.generated.GeneratedLinkRoutes
import io.agentmux.wakeword.WAKE_CHUNK_MS
import io.agentmux.wakeword.WakeRefusal
import io.agentmux.wakeword.WakeSensitivity
import io.agentmux.wakeword.WakeRun
import io.agentmux.wakeword.WakeTrace
import kotlinx.coroutines.delay

/** Twelve and a half readings a second is the loop's own rate; the page redraws with it, not faster. */
private const val TRACE_REFRESH_MS = WAKE_CHUNK_MS.toLong()

/**
 * WHAT: What the wake word hears while it waits: the live score against its threshold, the speech
 * probability beside it, how many chunks of the run are in, and the runs that ended with the rule that
 * decided each one.
 * WHY: Mattias 2026-09-19, "nån debugging där också så att man ser när den hör det eller inte hör det,
 * så att man kan tweaka det ordentligt". The measurement that set the run rule priced it against
 * synthesised clips that are too easy (docs/qa/2026-09-19-wake-detection-run), so the number it still
 * owes is a real phrase, really spoken, that the run rule refused. That case is the first row here and
 * it says so in words.
 */
@Composable
internal fun LinkWakeDebugScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val watching by LinkWakeDebug.watching.collectAsStateWithLifecycle()
    val wake by LinkWakeStatus.status.collectAsStateWithLifecycle()
    var trace by remember { mutableStateOf(LinkWakeDebug.read()) }
    var exported by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(watching) {
        while (watching) {
            trace = LinkWakeDebug.read()
            delay(TRACE_REFRESH_MS)
        }
        trace = LinkWakeDebug.read()
    }
    BackHandler(onBack = onBack)
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item("header") {
            PhoneScreenHeader(
                title = GeneratedLinkRoutes.descriptor(LinkRoute.WAKE_DEBUG).title,
                onBack = onBack,
                backLabel = "Back",
                icon = LinkNativeBindings.requireIcon(GeneratedLinkRoutes.descriptor(LinkRoute.WAKE_DEBUG).iconAssetRef),
            )
        }
        item("watching") {
            PhoneRow(
                title = if (watching) "WATCHING" else "NOT WATCHING",
                sub = if (watching) "Tap to stop · costs one extra model call per 80 ms" else "Tap to see what it hears",
                icon = LinkNativeBindings.requireIcon("record"),
                onTap = { LinkWakeDebug.setWatching(context, !watching) },
            )
        }
        item("phrase") {
            // The rule the page is watching is the wearer's step, not the shipped default, so both the
            // threshold and the run length are read from his choice and named beside it.
            PhoneRow(
                title = wake.phrase.spoken.uppercase(),
                sub = "${wakeSensitivityWord(wake.sensitivity)} · threshold " +
                    "${"%.2f".format(wake.sensitivity.thresholdFor(wake.phrase))} · " +
                    "${wake.sensitivity.detection.chunksOverThreshold} chunks in a row",
                icon = LinkNativeBindings.requireIcon("target"),
            )
        }
        item("live") { LiveReading(trace, wake.sensitivity.thresholdFor(wake.phrase)) }
        if (!watching) return@LazyColumn
        item("export") {
            PhoneRow(
                title = "EXPORT",
                sub = exported ?: "Writes ${runCount(trace.runs.size)} to one file · nothing is written otherwise",
                icon = LinkNativeBindings.requireIcon("download"),
                onTap = { exported = "Wrote ${LinkWakeDebug.export(context)}" },
            )
        }
        item("runs-heading") {
            PhoneRow(
                title = "LAST ${runCount(trace.runs.size).uppercase()} OVER THE THRESHOLD",
                sub = "Newest first · a refused one is a phrase that was not heard",
                icon = LinkNativeBindings.requireIcon("activity"),
            )
        }
        items(trace.runs, wake.sensitivity)
    }
}

@Composable
private fun LiveReading(trace: WakeTrace, threshold: Float) {
    val latest = trace.latest
    PhoneRow(
        title = latest?.let { "SCORE ${"%.2f".format(it.score)} · SPEECH ${"%.2f".format(it.speechProbability)}" }
            ?: "NOTHING HEARD YET",
        sub = latest?.let { reading ->
            val run = reading.chunksOverThreshold
            val over = if (reading.score >= threshold) "over ${"%.2f".format(threshold)}" else "under ${"%.2f".format(threshold)}"
            "$over · $run chunk(s) in a row · ${reading.atMs / 1_000} s of listening"
        } ?: "Say the phrase, or wait for the room to make a sound",
        icon = LinkNativeBindings.requireIcon("speaker"),
    )
}

/** A count and its noun, because "1 row(s)" is not something anyone says out loud. */
private fun runCount(runs: Int): String = if (runs == 1) "1 run" else "$runs runs"

private fun chunkCount(chunks: Int): String = if (chunks == 1) "1 chunk" else "$chunks chunks"

/** Each ended run as one row; the refused single chunk is named in words, because it is the case to look for. */
private fun androidx.compose.foundation.lazy.LazyListScope.items(runs: List<WakeRun>, step: WakeSensitivity) {
    runs.forEachIndexed { index, run ->
        item("run-$index-${run.atMs}") {
            PhoneRow(
                title = "${"%.2f".format(run.peakScore)} · ${chunkCount(run.chunksOverThreshold).uppercase()}",
                sub = runSentence(run, step),
                icon = LinkNativeBindings.requireIcon(if (run.accepted) "record" else "warning"),
            )
        }
    }
}

/**
 * What happened to one run, in the words the wearer needs rather than the rule's name. A refusal names the
 * step that refused it, because with a sensitivity to set, "the rule" is no longer one thing.
 */
private fun runSentence(run: WakeRun, step: WakeSensitivity): String {
    val at = "${run.atMs / 1_000} s"
    val speech = "speech ${"%.2f".format(run.speechProbability)}"
    val wants = "${wakeSensitivityWord(step)} wants ${step.detection.chunksOverThreshold}"
    return when (run.refusal) {
        null -> "$at · heard · became a question · $speech"
        WakeRefusal.NOT_ENOUGH_CHUNKS -> if (run.chunksOverThreshold == 1) {
            "$at · REFUSED · over the threshold once, $wants · $speech"
        } else {
            "$at · REFUSED · ${chunkCount(run.chunksOverThreshold)}, $wants · $speech"
        }
    }
}
