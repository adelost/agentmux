package io.agentmux.audioinbox

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.adelost.designkit.ui.CircleAccent
import com.adelost.designkit.ui.CircleAccentStrength
import com.adelost.designkit.ui.CircleText
import com.adelost.designkit.ui.circleAccentColor
import com.adelost.ringkit.ui.PhoneScreenHeader
import com.adelost.ringkit.ui.RingRow
import io.agentmux.linkui.product.LinkNativeBindings
import io.agentmux.linkui.product.LinkRoute
import io.agentmux.linkui.product.LinkWakePeak
import io.agentmux.linkui.product.generated.GeneratedLinkRoutes
import io.agentmux.linkui.product.wakePhaseWord
import io.agentmux.linkui.product.wakeSensitivityHint
import io.agentmux.linkui.product.wakeSensitivityWord
import io.agentmux.wakeword.RecordedTry
import io.agentmux.wakeword.WakePhase
import io.agentmux.wakeword.WakePhrase
import io.agentmux.wakeword.WakeSensitivity
import io.agentmux.wakeword.WakeTryVerdict
import io.agentmux.wakeword.showing
import kotlinx.coroutines.delay
import io.agentmux.linkui.product.generated.GeneratedLinkControlTiming

/**
 * WHAT: One page to try the wake phrase and choose how eagerly it answers. One utterance is judged under
 * all three steps at once, the verdict is for the step in use, the other two answer beside it, and a tap
 * on a step uses it. Nothing said here is acted on: no question starts, nothing is sent, no reply is read.
 * WHY: Mattias asked by voice for a test mode (row 217). Measured on 1.2.22: WAKE DEBUG does not hold the
 * wake back, so a phrase said there became a question; SENSITIVITY was a different row on a different
 * page; and the page that showed a verdict was called DEBUG. Trying the word and choosing the step are
 * one thing, and this is the page for it.
 *
 * The page is the only writer of the step (lsrc:0, step 8 point 1): the settings row that used to cycle
 * through the three words now opens this.
 */
@Composable
internal fun LinkWakeTryScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val wake by LinkWakeStatus.status.collectAsStateWithLifecycle()
    var trace by remember { mutableStateOf(LinkWakeTry.read()) }
    var peak by remember { mutableStateOf(LinkWakePeak()) }
    // The phrase the loop is listening for when the page opens is the one the page is about; it cannot
    // be changed from here, and a recorder is tied to the phrase it judged tries against.
    val phrase = remember { LinkWakeStatus.status.value.phrase }
    DisposableEffect(Unit) {
        LinkWakeTry.opened(context, phrase)
        onDispose { LinkWakeTry.closed(context) }
    }
    LaunchedEffect(Unit) {
        while (true) {
            val next = LinkWakeTry.read()
            trace = next
            peak = peak.after(next.latest)
            delay(TRACE_REFRESH_MS)
        }
    }
    BackHandler(onBack = onBack)
    val showing = trace.showing()
    val listening = wake.phase != WakePhase.OFF && wake.phase != WakePhase.BLOCKED
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item("header") {
            // The route's declared title cannot be the phrase, because three are offered and the wearer
            // picks one; the page can, and here is where naming it helps: it is what he has to say.
            PhoneScreenHeader(
                title = "TRY ${phrase.spoken.uppercase()}",
                onBack = onBack,
                backLabel = "Back",
                icon = LinkNativeBindings.requireIcon(
                    GeneratedLinkRoutes.descriptor(LinkRoute.WAKE_TRY).iconAssetRef,
                ),
            )
        }
        item("verdict") {
            if (listening) {
                Verdict(showing, wake.sensitivity, phrase)
            } else {
                // The page opens the microphone for as long as it is on screen, so when it has none it
                // says so where the answer would be, rather than waiting for words that cannot come.
                Verdict(
                    words = wakePhaseWord(wake.phase),
                    color = circleAccentColor(CircleAccent.DANGER),
                    why = wake.detail.ifBlank { "The microphone is not listening" },
                )
            }
        }
        item("meter") { TryMeter(trace.latest?.score ?: 0f, shownPeak(showing, peak), wake.sensitivity, phrase) }
        item("steps-label") { PageLabel("THIS TRY, UNDER EACH STEP") }
        WakeSensitivity.offered.forEach { step ->
            item("step-${step.id}") {
                StepRow(step, showing, inUse = step == wake.sensitivity) {
                    LinkWakeSensitivityChoice.choose(context, step)
                }
            }
        }
        item("nothing-sent") { PageLabel("Tap a step to use it. Nothing is sent while you try.") }
        item("last-tries") { LastTries(trace.tries) }
    }
}

/**
 * One size for every verdict, and room for the two lines the longest one takes. Measured at 27 sp:
 * "NOT THE PHRASE", the longest line any verdict breaks into, is about 234 dp wide inside the block's
 * 272 dp at the narrowest phone this page is offered on.
 */
private const val VERDICT_SP = 27f
private val VERDICT_HEIGHT = 72.dp
private val WHY_HEIGHT = 32.dp

/** The peak the page is reading against: the try being shown, or the live meter's own hold. */
private fun shownPeak(showing: RecordedTry?, peak: LinkWakePeak): Float =
    showing?.judged?.highestScore ?: peak.score

@Composable
private fun Verdict(showing: RecordedTry?, step: WakeSensitivity, phrase: WakePhrase) {
    val verdict = showing?.judged?.verdictFor(step, phrase) ?: WakeTryVerdict.SAY_IT_NOW
    Verdict(
        words = wakeTryVerdictWords(verdict),
        color = circleAccentColor(
            when (verdict) {
                WakeTryVerdict.WOULD_WAKE -> CircleAccent.POSITIVE
                WakeTryVerdict.SAY_IT_NOW -> CircleAccent.NEUTRAL
                else -> CircleAccent.DANGER
            },
        ),
        why = wakeTryWhy(showing, step, phrase),
    )
}

/**
 * The answer, then one line of why. Both are for the step in use; the rows below carry the other two.
 *
 * The block is one height and one type size whatever it says. lsrc:0 2026-09-19 measured the first
 * version: the longest verdict shrank its own type and everything under it jumped about 8 px between
 * states, so a wearer who says the phrase twice sees the page move rather than the answer change. The
 * longest verdict breaks onto two lines inside the same box instead.
 */
@Composable
private fun Verdict(words: String, color: androidx.compose.ui.graphics.Color, why: String) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, top = 22.dp, bottom = 14.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        FixedLines(VERDICT_HEIGHT) {
            CircleText(
                text = words,
                color = color,
                fontSizeSp = VERDICT_SP,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
                maxLines = 2,
                balancedLines = true,
            )
        }
        Spacer(Modifier.height(8.dp))
        FixedLines(WHY_HEIGHT) {
            CircleText(
                text = why,
                color = circleAccentColor(CircleAccent.NEUTRAL, CircleAccentStrength.SUPPORTING),
                fontSizeSp = 12f,
                textAlign = TextAlign.Center,
                maxLines = 2,
            )
        }
    }
}

/**
 * Two lines' worth of room, with one line centred in it. CircleText's sizes are fixed against the
 * wearer's font scale (circleFixedSp), so a height in dp holds two of them on any phone.
 */
@Composable
private fun FixedLines(height: Dp, content: @Composable () -> Unit) {
    Box(
        modifier = Modifier.fillMaxWidth().height(height),
        contentAlignment = Alignment.Center,
        content = { content() },
    )
}

/**
 * The meter with every step's mark on it, which is what makes one number worth reading: a peak means
 * nothing on its own, and beside three marks it says which steps it cleared and by how much.
 */
@Composable
private fun TryMeter(score: Float, peak: Float, step: WakeSensitivity, phrase: WakePhrase) {
    val dim = circleAccentColor(CircleAccent.NEUTRAL, CircleAccentStrength.INACTIVE)
    val supporting = circleAccentColor(CircleAccent.NEUTRAL, CircleAccentStrength.SUPPORTING)
    val bright = circleAccentColor(CircleAccent.NEUTRAL, CircleAccentStrength.ACTIVE)
    val track = meterTrack(bright)
    Column(modifier = phoneRowModifier().padding(start = meterTextInset(), top = 6.dp, bottom = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Spacer(Modifier.weight(1f))
            CircleText(
                text = if (peak > 0f) "PEAK ${"%.2f".format(peak)}" else "PEAK --",
                color = bright,
                fontSizeSp = 12f,
                fontWeight = FontWeight.Bold,
                tabularNumerals = true,
            )
        }
        Spacer(Modifier.height(7.dp))
        Canvas(Modifier.fillMaxWidth().height(METER_HEIGHT)) {
            val radius = CornerRadius(size.height / 2f, size.height / 2f)
            drawRoundRect(color = track, cornerRadius = radius)
            val filled = maxOf(score, peak).coerceIn(0f, 1f)
            if (filled > 0f) {
                drawRoundRect(color = supporting, size = Size(size.width * filled, size.height), cornerRadius = radius)
            }
            // The step in use is the one the verdict is about, so its mark is the loudest of the three.
            WakeSensitivity.offered.forEach { offered ->
                tick(
                    at = offered.thresholdFor(phrase),
                    color = if (offered == step) bright else dim,
                    size = size,
                )
            }
        }
        Spacer(Modifier.height(8.dp))
        CircleText(
            text = WakeSensitivity.offered.reversed().joinToString(" · ") { wakeSensitivityWord(it) } + " marks",
            color = dim,
            fontSizeSp = 11f,
            letterSpacingSp = 0.4f,
        )
    }
}

/** One step: what it would have done with this try, whether it is the one in use, and a tap to use it. */
@Composable
private fun StepRow(step: WakeSensitivity, showing: RecordedTry?, inUse: Boolean, onUse: () -> Unit) {
    val wakes = showing?.judged?.byStep?.getValue(step)?.wakes
    RingRow(
        title = wakeSensitivityWord(step),
        sub = if (inUse) "IN USE" else "",
        // The declared sentence for the step follows the choice to the page the choice now lives on.
        hint = wakeSensitivityHint(step),
        icon = LinkNativeBindings.requireIcon("target"),
        onTap = onUse.takeIf { !inUse },
        actionTiming = GeneratedLinkControlTiming.WAKE_TRY_TRY_PHRASE,
        trailing = {
            CircleText(
                text = wakeTryStepWord(showing, step),
                color = when (wakes) {
                    null -> circleAccentColor(CircleAccent.NEUTRAL, CircleAccentStrength.INACTIVE)
                    true -> circleAccentColor(CircleAccent.POSITIVE)
                    false -> circleAccentColor(CircleAccent.DANGER)
                },
                fontSizeSp = 13f,
                fontWeight = FontWeight.Bold,
                letterSpacingSp = 0.6f,
            )
        },
        modifier = phoneRowModifier(),
    )
}

/** The last five, newest first, in memory only: nothing on this page is written anywhere. */
@Composable
private fun LastTries(tries: List<RecordedTry>) {
    Column(modifier = phoneRowModifier().padding(start = meterTextInset(), top = 10.dp)) {
        CircleText(
            text = "LAST TRIES",
            color = circleAccentColor(CircleAccent.NEUTRAL, CircleAccentStrength.INACTIVE),
            fontSizeSp = 11f,
            letterSpacingSp = 0.6f,
        )
        tries.forEach { recorded ->
            Spacer(Modifier.height(6.dp))
            CircleText(
                text = wakeTryLine(recorded),
                color = circleAccentColor(CircleAccent.NEUTRAL, CircleAccentStrength.SUPPORTING),
                fontSizeSp = 12f,
                tabularNumerals = true,
                maxLines = 1,
            )
        }
    }
}

/** A quiet line that titles the block under it, on the same left edge as the rows. */
@Composable
private fun PageLabel(text: String) {
    CircleText(
        text = text,
        color = circleAccentColor(CircleAccent.NEUTRAL, CircleAccentStrength.INACTIVE),
        fontSizeSp = 11f,
        letterSpacingSp = 0.4f,
        modifier = phoneRowModifier().padding(start = meterTextInset(), top = 8.dp, bottom = 2.dp),
    )
}
