// Decides the one obvious action for a quiet pane and words the message for it (docs/DESIGN-quiet-panes.md, chapter 6).
// Pure: the cron (cli/quiet.mjs) and the replay (cli/quiet-replay.mjs) call the same planner, so the replay shows what the
// cron would do. Every message that leaves starts with the [quiet] tag, which core/ask-origin.mjs lists among amux's own.

import { DORMANT_MS } from "./quiet-episodes.mjs";
import { parseSenderHeader } from "./sender-detect.mjs";
import { authoredPromptText } from "./system-noise.mjs";

/** WHAT: Names the tag every quiet message starts with. WHY: Keeps the pane's copy of the message from counting as his. */
export const QUIET_TAG = "[quiet]";
/** WHAT: Names the pane that gets the decisions a delegate can make. WHY: Keeps one dispatcher pane as the default until the operator names another. */
export const DEFAULT_DELEGATE = "lsrc:0";
/** WHAT: Defines how long a forwarded decision may go unanswered before the one reminder. WHY: Keeps a slow answer from becoming a stream of reminders. */
export const REMIND_AFTER_MS = 30 * 60_000;
/** WHAT: Defines the gap between two tries of a send the queue refused. WHY: Keeps a refused send from repeating on every cron run. */
export const RETRY_AFTER_MS = 10 * 60_000;
/** WHAT: Defines how many times a refused send is tried. WHY: Stops a send that cannot succeed from retrying for ever. */
export const MAX_ATTEMPTS = 3;

const FORWARD_MAX = 400;
const NUDGE_MAX = 300;
const HANDS_MAX = 160;

/** WHAT: Formats a moment as hh:mmZ. WHY: Keeps every quiet message and replay line on one clock. */
export const clockOf = (ms) => `${new Date(ms).toISOString().slice(11, 16)}Z`;

// Keeps the start and the end of a long line, because a pane ends with its ask and its cost.
function clip(text, max) {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 3) * 0.6);
  return `${text.slice(0, head).trimEnd()} … ${text.slice(text.length - (max - 3 - head)).trimStart()}`;
}

/** WHAT: Formats the message that hands a decision to the delegate. WHY: Keeps the pane's own line in it, never his words. */
export function forwardText({ pane, sinceMs, line }) {
  const head = `${QUIET_TAG} ${pane} waits for a decision you can make (${clockOf(sinceMs)}): "`;
  const tail = `" Reply to ${pane}.`;
  return `${head}${clip(line, FORWARD_MAX - head.length - tail.length)}${tail}`;
}

/** WHAT: Formats the one reminder about a decision that nobody answered. WHY: Keeps the reminder short and tied to the forward. */
export const reminderText = ({ pane, sinceMs, forwardedMs }) =>
  `${QUIET_TAG} reminder: ${pane} still waits for your decision since ${clockOf(sinceMs)} (forwarded ${clockOf(forwardedMs)}).`;

/** WHAT: Formats the nudge to a pane's lead about work left with no blocker. WHY: Keeps the LEFT line in it so the lead can act without a lookup. */
export function nudgeText({ pane, endMs, line }) {
  const head = `${QUIET_TAG} ${pane} stopped at ${clockOf(endMs)} with work left and no blocker: "`;
  const tail = "\". Restart it or hand the work on.";
  return `${head}${clip(line, NUDGE_MAX - head.length - tail.length)}${tail}`;
}

/** WHAT: Formats one line of the list of panes that wait for his hands. WHY: Keeps the list readable at a glance. */
export function handsLine({ pane, since, what, line }) {
  const head = `${pane} · since ${clockOf(since)} · ${what}: "`;
  return `${head}${clip(line, HANDS_MAX - head.length - 1)}"`;
}

const PANE_KEY = /\b([A-Za-z][\w-]*:\d+)\b/gu;
const panesIn = (cell) => [...String(cell ?? "").matchAll(PANE_KEY)].map(([, key]) => key);

/**
 * The roster is ~/.agentmux/ROSTER.md: a table with a Lead and a Builders column. The lead of the project whose builders
 * name the pane wins; otherwise the agent's own pane 0; otherwise the delegate.
 * WHAT: Resolves the pane that leads a pane.
 * WHY: Keeps a nudge going to whoever staffs the work, not to a pane picked by hand.
 */
export function leadOf(pane, rosterText, { delegate = DEFAULT_DELEGATE } = {}) {
  const rows = String(rosterText ?? "").split("\n").filter((line) => line.trimStart().startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const header = rows.find((cells) => cells.some((cell) => /^lead$/iu.test(cell)) && cells.some((cell) => /^builders/iu.test(cell)));
  if (header) {
    const [leadAt, buildersAt] = [header.findIndex((cell) => /^lead$/iu.test(cell)), header.findIndex((cell) => /^builders/iu.test(cell))];
    for (const cells of rows) {
      const lead = panesIn(cells[buildersAt]).includes(pane) ? panesIn(cells[leadAt])[0] : null;
      if (lead && cells !== header) return lead;
    }
  }
  const agent = pane.slice(0, pane.lastIndexOf(":"));
  return agent ? `${agent}:0` : delegate;
}

const senderOf = (ask) => ask.sender || parseSenderHeader(authoredPromptText(ask.verbatim))?.key || null;
const retryDue = (entry, nowMs) => entry.attempts < MAX_ATTEMPTS && nowMs - entry.at >= RETRY_AFTER_MS;
const skipped = (episode, reason, notable = true) => ({ kind: "skip", reason, notable, episode });

// A message goes out only to a pane with a ledger row in the last 2 hours: a dormant pane is never woken.
function outgoing(episode, { kind, target, key, text, prior }, { nowMs, index }) {
  if (index.lastRowAt(target, nowMs) < nowMs - DORMANT_MS) {
    return skipped(episode, `${kind === "nudge" ? "lead" : "delegate"} ${target} is dormant (no ledger row in 2 h)`);
  }
  return { kind, target, key, text, attempts: (prior?.attempts ?? 0) + 1, episode };
}

// What an earlier try of the same key allows: nothing new once it went out (or its outcome is unknown), another try
// when the queue refused it, 10 minutes apart and three times at most. Returns null when the send may go on.
function blockedByPrior(episode, prior, label, nowMs) {
  if (!prior) return null;
  if (prior.state !== "failed") return skipped(episode, `${label} already went out`, false);
  if (retryDue(prior, nowMs)) return null;
  const spent = prior.attempts >= MAX_ATTEMPTS;
  return skipped(episode, spent ? `${label} failed ${prior.attempts} times, so it is not sent again` : `${label} failed; it is tried again 10 min after the last try`, spent);
}

// The newest forward about a pane in the last 30 minutes that went out, or null.
const recentForwardAbout = (pane, seen, nowMs) => Object.entries(seen)
  .filter(([key, entry]) => key.startsWith(`quiet:${pane}:`) && entry.kind === "forward" && entry.state !== "failed"
    && nowMs - entry.at < REMIND_AFTER_MS)
  .map(([, entry]) => entry).sort((left, right) => right.at - left.at)[0] ?? null;

function decisionPlan(episode, context) {
  const { nowMs, seen, delegate, index } = context;
  const { pane, key, verdict } = episode;
  if (pane === delegate) return skipped(episode, `${pane} is the delegate, so its own decision stays with it`);
  const forwarded = seen[key];
  // One decision per pane at a time: another wording of it waits for the delegate's answer or the reminder (design v4;
  // claw:0 asked one decision in two wordings at 09:10 and 09:19Z on 2026-10-20).
  const earlier = forwarded ? null : recentForwardAbout(pane, seen, nowMs);
  if (earlier && !index.asksAfter(pane, earlier.at, nowMs).some((ask) => senderOf(ask) === delegate)) {
    return skipped(episode, `a decision of ${pane} went to ${delegate} at ${clockOf(earlier.at)} and is not answered yet`, false);
  }
  if (!forwarded || forwarded.state === "failed") {
    const forward = { kind: "forward", target: delegate, key, text: forwardText({ pane, sinceMs: episode.sinceMs, line: verdict.line }), prior: forwarded };
    return blockedByPrior(episode, forwarded, "the forward", nowMs) ?? outgoing(episode, forward, context);
  }
  const reminderKey = `${key}:reminder`;
  const reminded = seen[reminderKey];
  const remind = { kind: "reminder", target: delegate, key: reminderKey, prior: reminded,
    text: reminderText({ pane, sinceMs: forwarded.since ?? episode.sinceMs, forwardedMs: forwarded.at }) };
  if (reminded) return blockedByPrior(episode, reminded, "the reminder", nowMs) ?? outgoing(episode, remind, context);
  if (nowMs - forwarded.at < REMIND_AFTER_MS) return skipped(episode, "forwarded; the reminder is not due yet", false);
  if (index.asksAfter(pane, forwarded.at, nowMs).some((ask) => senderOf(ask) === delegate)) {
    return skipped(episode, `${delegate} has answered it since the forward`, false);
  }
  return outgoing(episode, remind, context);
}

function nudgePlan(episode, context) {
  const { nowMs, seen, leadFor } = context;
  const { pane, key, verdict } = episode;
  const lead = leadFor(pane);
  if (lead === pane) return skipped(episode, `${pane} is its own lead, so there is nobody to nudge`);
  const nudge = { kind: "nudge", target: lead, key, prior: seen[key], text: nudgeText({ pane, endMs: episode.endMs, line: verdict.line }) };
  return blockedByPrior(episode, seen[key], "the nudge", nowMs) ?? outgoing(episode, nudge, context);
}

const SLEEPS = { quota: "quota: the quota park holds it", done: "done", unclear: "unclear, so it sleeps" };

/**
 * Returns {kind: forward|reminder|nudge, target, key, text, attempts}, {kind: hands, entry}, or {kind: skip, reason,
 * notable}. A skip that is `notable` is worth a line in the cron's log; a sleeping pane is not. The context carries the
 * moment `nowMs`, the store's `seen` map, the `delegate`, `leadFor(pane)` and the ledger `index`.
 * WHAT: Returns the one obvious action for a quiet episode, or a skip.
 * WHY: Keeps the rules of who is told, once, and never when dormant in one pure function.
 */
export function planEpisode(episode, context) {
  const { class: cls } = episode.verdict;
  if (cls === "hands") {
    const { verdict, sinceMs, startMs, key } = episode;
    return { kind: "hands", episode, entry: { since: sinceMs, from: startMs, line: verdict.line, what: verdict.what, key } };
  }
  if (cls === "decision") return decisionPlan(episode, { delegate: DEFAULT_DELEGATE, ...context });
  if (cls === "left") return nudgePlan(episode, { delegate: DEFAULT_DELEGATE, ...context });
  return skipped(episode, SLEEPS[cls], false);
}

/**
 * `listed` are the hands plans of this run, `open` the open episodes. An entry stays until a message reaches the pane
 * after the reply it stands for, or the pane has moved on to a reply that is not his hands.
 * WHAT: Builds the next hands list from the last list and this run.
 * WHY: Keeps an undone login listed, and drops it once the pane is asked again.
 */
export function nextHands(previous, { listed, open, index }) {
  const next = {};
  for (const [pane, entry] of Object.entries(previous)) {
    const asked = index.asksAfter(pane, entry.from ?? entry.since).length > 0;
    const movedOn = open.some((episode) => episode.pane === pane && episode.startMs > (entry.from ?? entry.since) && episode.verdict.class !== "hands");
    if (!asked && !movedOn) next[pane] = entry;
  }
  for (const { episode, entry } of listed) next[episode.pane] = entry;
  return next;
}
