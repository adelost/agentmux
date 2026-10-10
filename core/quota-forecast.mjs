// Weekly Claude quota forecast and the warning text built from it.
//
// Mattias 2026-10-10: "tänk dock på att inte byta i onödan.. pga cache miss".
// A switch costs every moved pane a cache miss, so the warning leads with the
// cheapest action that works: nothing when the pace lasts until the reset, a
// free reset if he has one (amux cannot see those), and only then a switch.

import { formatReset } from "./quota-format.mjs";

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;
// Pace from the readings of the last day; a shorter span than an hour is noise.
const RECENT_SPAN_MS = 24 * HOUR_MS;
const MIN_PACE_SPAN_MS = HOUR_MS;
// The provider's reset timestamp drifts by seconds between readings of one window.
const SAME_WINDOW_MS = 30 * 60_000;

const sameWindow = (point, resetAt) => Math.abs(Date.parse(point?.resetsAt) - resetAt) < SAME_WINDOW_MS;

/**
 * WHAT: Returns the weekly burn rate in percent per hour and what it was measured on.
 * WHY: Keeps a forecast on readings already taken, falling back to the window average when they span too little.
 */
export function weeklyPace(history, latest, now) {
  const resetAt = Date.parse(latest?.resetsAt);
  if (!Number.isFinite(resetAt) || !Number.isFinite(latest?.usedPercent)) return null;
  const recent = history
    .filter((point) => Number.isFinite(point?.at) && Number.isFinite(point?.usedPercent)
      && point.at <= now && now - point.at <= RECENT_SPAN_MS && sameWindow(point, resetAt))
    .sort((left, right) => left.at - right.at);
  const first = recent[0], last = recent.at(-1);
  if (first && last && last.at - first.at >= MIN_PACE_SPAN_MS) {
    const spanMs = last.at - first.at;
    return { percentPerHour: Math.max(0, (last.usedPercent - first.usedPercent) / (spanMs / HOUR_MS)),
      basis: "recent", spanHours: spanMs / HOUR_MS };
  }
  const elapsedMs = now - (resetAt - WEEK_MS);
  if (!(elapsedMs > 0)) return null;
  return { percentPerHour: latest.usedPercent / (elapsedMs / HOUR_MS), basis: "window", spanHours: elapsedMs / HOUR_MS };
}

/** WHAT: Calculates when the weekly limit runs out at the current pace. WHY: Keeps "switch now" from being suggested when the pace lasts until the reset. */
export function weeklyForecast({ history = [], latest, now }) {
  const pace = weeklyPace(history, latest, now);
  const resetAt = Date.parse(latest?.resetsAt);
  const remaining = Math.max(0, 100 - latest.usedPercent);
  const from = Number.isFinite(latest?.at) ? latest.at : now;
  const exhaustAt = pace && pace.percentPerHour > 0 ? from + (remaining / pace.percentPerHour) * HOUR_MS : null;
  return { usedPercent: latest.usedPercent, resetsAt: latest.resetsAt, resetAt, pace, exhaustAt,
    lastsUntilReset: Number.isFinite(resetAt) && (exhaustAt === null || exhaustAt >= resetAt) };
}

/**
 * WHAT: Maps a forecast to the notice it deserves, if any.
 * WHY: Keeps one ordinary notice at the threshold and one stronger one when the limit is hours away.
 */
export function weeklyNoticeLevel(forecast, { warnPercent, urgentHours, now }) {
  if (!forecast || !Number.isFinite(forecast.resetAt) || now >= forecast.resetAt) return null;
  // Below the threshold a fast hour early in the week is a burst, not a forecast worth a notice.
  if (forecast.usedPercent < warnPercent) return null;
  return !forecast.lastsUntilReset && forecast.exhaustAt - now <= urgentHours * HOUR_MS ? "urgent" : "threshold";
}

const when = (ms) => formatReset(new Date(ms).toISOString()).replace(/^reset /u, "");
const percent = (value) => `${Math.round(value)} %`;

function paceText(pace) {
  const rate = `${pace.percentPerHour.toFixed(1).replace(".", ",")} %/h`;
  return pace.basis === "recent" ? `${rate} (senaste ${Math.max(1, Math.round(pace.spanHours))} h)`
    : `${rate} (snitt sedan veckan började)`;
}

function switchStep(alternatives) {
  const best = alternatives[0];
  if (!best) return "2. Inget annat Claude-konto går att byta till just nu.";
  return `2. Annars byt konto: \`amux accounts rotate claude:${best.email} --dry\` visar planen per panel, `
    + `samma kommando utan --dry byter. ${best.email} har ${percent(best.usedPercent)} av veckan, ${formatReset(best.resetsAt)}.`;
}

/**
 * WHAT: Builds the notice text, cheapest action first.
 * WHY: Keeps a quota warning from pushing a switch, and its cache misses, that the pace does not need.
 */
export function formatWeeklyNotice({ level, email, forecast, alternatives = [], now }) {
  const reset = formatReset(forecast.resetsAt);
  if (forecast.lastsUntilReset) {
    return `Claude ${email}: ingen åtgärd. ${percent(forecast.usedPercent)} av veckan använt, `
      + `takten ${paceText(forecast.pace)} räcker till ${reset}.`;
  }
  const hoursLeft = Math.max(1, Math.round((forecast.exhaustAt - now) / HOUR_MS));
  const headline = level === "urgent"
    ? `Claude ${email} tar slut om ca ${hoursLeft} h (${when(forecast.exhaustAt)}), före ${reset}. ${percent(forecast.usedPercent)} av veckan använt, takten ${paceText(forecast.pace)}.`
    : `Claude ${email}: ${percent(forecast.usedPercent)} av veckan använt. I takten ${paceText(forecast.pace)} tar den slut ${when(forecast.exhaustAt)}, före ${reset}.`;
  return [headline,
    "1. Om du har en gratis reset: använd den på claude.ai under Settings, Usage. Då behövs inget byte och ingen cache går förlorad.",
    switchStep(alternatives)].join("\n");
}
