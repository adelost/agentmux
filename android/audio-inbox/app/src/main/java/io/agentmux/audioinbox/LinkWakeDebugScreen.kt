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
import java.time.format.DateTimeFormatter
import java.time.ZoneId
import java.time.Instant
import io.agentmux.wakeword.WakeChunkReading
import io.agentmux.wakeword.TracedRun
import io.agentmux.linkui.product.LinkWakePeak
import com.adelost.designkit.ui.circleAccentColor
import com.adelost.designkit.ui.CircleText
import com.adelost.designkit.ui.MenuDesign
import com.adelost.designkit.ui.phoneSurfaceDesign
import com.adelost.designkit.ui.CircleAccentStrength
import com.adelost.designkit.ui.CircleAccent
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.Canvas
import io.agentmux.linkui.product.LinkRoute
import io.agentmux.linkui.product.wakeSensitivityWord
import io.agentmux.linkui.product.generated.GeneratedLinkRoutes
import io.agentmux.wakeword.WAKE_CHUNK_MS
import io.agentmux.wakeword.WakeRefusal
import io.agentmux.wakeword.WakeSensitivity
import io.agentmux.wakeword.WakeRun
import kotlinx.coroutines.delay

/** The bar's own shape: tall enough to read at a glance, and marks that overhang it so they are visible. */
private val METER_HEIGHT = 12.dp
private val SPEECH_HEIGHT = 4.dp
private val TICK_WIDTH = 2.dp
private val TICK_OVERHANG = 3.dp

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
    var peak by remember { mutableStateOf(LinkWakePeak()) }
    var exported by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(watching) {
        while (watching) {
            val next = LinkWakeDebug.read()
            trace = next
            peak = peak.after(next.latest)
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
        item("live") { WakeMeter(trace.latest, peak, wake.sensitivity.thresholdFor(wake.phrase)) }
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

/**
 * The live score as a meter rather than as digits. lsrc:0 D1, 2026-09-19: the page showed numbers changing
 * twelve times a second, and nobody can tune by reading those. The bar carries the score, a tick carries
 * the threshold it is judged against, and a held peak keeps an 80 ms near miss on screen long enough to
 * see. The thin bar under it is how sure the speech model is that this was a voice at all.
 */
@Composable
private fun WakeMeter(latest: WakeChunkReading?, peak: LinkWakePeak, threshold: Float) {
    val dim = circleAccentColor(CircleAccent.NEUTRAL, CircleAccentStrength.INACTIVE)
    val supporting = circleAccentColor(CircleAccent.NEUTRAL, CircleAccentStrength.SUPPORTING)
    val bright = circleAccentColor(CircleAccent.NEUTRAL, CircleAccentStrength.ACTIVE)
    // The design system has no meter, so it has no token for the part of a bar that is empty. The dimmest
    // text colour is still far too loud for it: at full strength the track reads as a full bar.
    val track = bright.copy(alpha = 0.16f)
    val score = latest?.score ?: 0f
    val over = latest != null && score >= threshold
    // The page has one left edge for everything that carries meaning, so the bars start where a row's
    // words start: its own padding, the icon this block does not have, and the gap after it. The numbers
    // are this surface's own, not the watch's, which is why they come from the phone design rather than
    // from the shared menu metrics.
    val phone = phoneSurfaceDesign()
    val textInset = MenuDesign.rowPaddingH + phone.rowIconDiameter + phone.rowIconTextGap
    Column(modifier = phoneRowModifier().padding(start = textInset, top = 10.dp, bottom = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            CircleText("SCORE", dim, 11f, letterSpacingSp = 0.6f)
            Spacer(Modifier.width(6.dp))
            CircleText(latest?.let { "%.2f".format(it.score) } ?: "--", bright, 16f, tabularNumerals = true)
            Spacer(Modifier.weight(1f))
            CircleText("THRESHOLD ${"%.2f".format(threshold)}", dim, 11f, tabularNumerals = true)
        }
        Spacer(Modifier.height(7.dp))
        Canvas(Modifier.fillMaxWidth().height(METER_HEIGHT)) {
            val radius = CornerRadius(size.height / 2f, size.height / 2f)
            drawRoundRect(color = track, cornerRadius = radius)
            if (score > 0f) {
                drawRoundRect(
                    color = if (over) bright else supporting,
                    size = Size(size.width * score.coerceIn(0f, 1f), size.height),
                    cornerRadius = radius,
                )
            }
            // The peak first, so the threshold tick is never hidden under it.
            tick(peak.score, supporting.copy(alpha = 0.75f), size)
            tick(threshold, bright, size)
        }
        Spacer(Modifier.height(5.dp))
        Canvas(Modifier.fillMaxWidth().height(SPEECH_HEIGHT)) {
            val radius = CornerRadius(size.height / 2f, size.height / 2f)
            drawRoundRect(color = track, cornerRadius = radius)
            val speech = (latest?.speechProbability ?: 0f).coerceIn(0f, 1f)
            if (speech > 0f) {
                drawRoundRect(color = dim, size = Size(size.width * speech, size.height), cornerRadius = radius)
            }
        }
        Spacer(Modifier.height(8.dp))
        CircleText(meterSentence(latest, peak, threshold), supporting, 12f)
    }
}

/** One mark across the bar, at a probability's own place on it. */
private fun DrawScope.tick(at: Float, color: Color, size: Size) {
    val x = size.width * at.coerceIn(0f, 1f)
    drawLine(
        color = color,
        start = Offset(x, -TICK_OVERHANG.toPx()),
        end = Offset(x, size.height + TICK_OVERHANG.toPx()),
        strokeWidth = TICK_WIDTH.toPx(),
    )
}

/** What the bars do not say: how sure the speech model is, how much of a run is in, and for how long. */
private fun meterSentence(latest: WakeChunkReading?, peak: LinkWakePeak, threshold: Float): String {
    if (latest == null) return "Say the phrase, or wait for the room to make a sound"
    val run = if (latest.chunksOverThreshold > 0) "${chunkCount(latest.chunksOverThreshold)} in a row · " else ""
    val held = if (peak.score > latest.score) "peak ${"%.2f".format(peak.score)} · " else ""
    val over = if (latest.score >= threshold) "over the threshold · " else ""
    return "$over$held${run}speech ${"%.2f".format(latest.speechProbability)} · " +
        "${latest.atMs / 1_000} s of listening"
}

/** A count and its noun, because "1 row(s)" is not something anyone says out loud. */
private fun runCount(runs: Int): String = if (runs == 1) "1 run" else "$runs runs"

private fun chunkCount(chunks: Int): String = if (chunks == 1) "1 chunk" else "$chunks chunks"

/** Each ended run as one row, verdict first, because that is what a wearer is looking for. */
private fun androidx.compose.foundation.lazy.LazyListScope.items(runs: List<TracedRun>, step: WakeSensitivity) {
    runs.forEachIndexed { index, traced ->
        item("run-$index-${traced.run.atMs}") {
            PhoneRow(
                title = runTitle(traced.run),
                sub = runSentence(traced, step),
                icon = LinkNativeBindings.requireIcon(if (traced.run.accepted) "record" else "warning"),
            )
        }
    }
}

/** lsrc:0 D2, 2026-09-19: the verdict leads and the score follows it. */
internal fun runTitle(run: WakeRun): String =
    "${if (run.accepted) "WOKE" else "REFUSED"} · ${"%.2f".format(run.peakScore)}"

/** The wearer's own clock, because "9 s" does not say since what. */
private val RUN_TIME = DateTimeFormatter.ofPattern("HH:mm:ss")

internal fun runClock(wallClockMs: Long, zone: ZoneId = ZoneId.systemDefault()): String =
    RUN_TIME.format(Instant.ofEpochMilli(wallClockMs).atZone(zone))

/**
 * What happened to one run, in the words the wearer needs rather than the rule's name. A refusal names the
 * step that refused it, because with a sensitivity to set, "the rule" is no longer one thing. The verdict
 * itself is the row's title, so it is not repeated here.
 */
internal fun runSentence(traced: TracedRun, step: WakeSensitivity, zone: ZoneId = ZoneId.systemDefault()): String {
    val run = traced.run
    val speech = "speech ${"%.2f".format(run.speechProbability)}"
    val wants = "${wakeSensitivityWord(step)} wants ${step.detection.chunksOverThreshold}"
    val what = when (run.refusal) {
        null -> "became a question"
        WakeRefusal.NOT_ENOUGH_CHUNKS -> if (run.chunksOverThreshold == 1) {
            "one chunk only, $wants"
        } else {
            "${chunkCount(run.chunksOverThreshold)}, $wants"
        }
    }
    return "$what · $speech · ${runClock(traced.wallClockMs, zone)}"
}
