// `amux quiet --replay`: reads the conversation log between two moments and prints what `amux quiet --act` would have
// done, episode by episode, plus how many asks the old and the new needs-you rule would have flagged. It sends nothing and
// writes nothing (docs/DESIGN-quiet-panes.md, UC-6).

import { filterAskEntries } from "../core/ask-history.mjs";
import { readWindow } from "../core/ask-ledger.mjs";
import { conversationAskEntries } from "../core/conversation-view.mjs";
import { isAskToHuman } from "../core/orchestrator-checkpoint.mjs";
import { DORMANT_MS, indexLedger, quietEpisodes } from "../core/quiet-episodes.mjs";
import { REMIND_AFTER_MS, clockOf, leadOf, planEpisode } from "../core/quiet-plan.mjs";

const LABELS = { hands: "hands", decision: "decision", quota: "quota", left: "left work", done: "done", unclear: "unclear" };
const SUMMARY_ORDER = ["hands", "decision", "quota", "left", "done", "unclear"];
const SENDS = new Set(["forward", "reminder", "nudge"]);
const QUOTE_MAX = 70;

// The old rule: any reply that asks the human something is needs-you.
const asksHuman = (reply, prompt) => (isAskToHuman(reply, prompt) ? "needs-you" : null);

// Only the park record on disk is known, so a reply counts as parked when that record covers its moment.
const parkedThen = (record, atMs) => Boolean(record) && Date.parse(record.parkedAt) <= atMs
  && (record.state === "parked" || Date.parse(record.resumedAt) >= atMs);

const quoted = (line) => (line ? ` "${line.length > QUOTE_MAX ? `${line.slice(0, QUOTE_MAX - 1)}…` : line}"` : "");
const range = (sinceMs, untilMs) => {
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const [from, to] = [clockOf(sinceMs).slice(0, 5), clockOf(untilMs)];
  return day(sinceMs) === day(untilMs) ? `${from}–${to}` : `${day(sinceMs)} ${from}–${day(untilMs)} ${to}`;
};

function describe(plan, repeatOf) {
  if (SENDS.has(plan.kind)) return `${plan.kind} to ${plan.target}${quoted(plan.episode.verdict.line)} (${plan.key})`;
  if (plan.kind === "hands") return repeatOf ? `same line as ${clockOf(repeatOf.startMs)}, already listed` : `list as hands (${plan.entry.what})${quoted(plan.entry.line)}`;
  return repeatOf ? `same line as ${clockOf(repeatOf.startMs)}: ${plan.reason}` : plan.reason;
}

// What the cron would do, with the memory of the keys it would have kept, at the moments it would have looked.
function simulate(episodes, { seen, delegate, leadFor, index, untilMs }) {
  const lines = [];
  const firstOf = new Map();
  const record = (plan, nowMs) => {
    if (SENDS.has(plan.kind)) seen[plan.key] = { at: nowMs, state: "sent", target: plan.target, kind: plan.kind, since: plan.episode.sinceMs };
  };
  for (const episode of episodes) {
    const repeatOf = firstOf.get(episode.key);
    if (!repeatOf) firstOf.set(episode.key, episode);
    const step = (nowMs) => {
      const plan = planEpisode(episode, { nowMs, seen, delegate, leadFor, index });
      record(plan, nowMs);
      lines.push({ nowMs, episode, plan, text: describe(plan, repeatOf) });
      return plan;
    };
    step(episode.quietFromMs);
    // A reminder is due 30 minutes after a forward, if the pane is still quiet on the same line then.
    const forwarded = seen[episode.key];
    const remindMs = forwarded ? Math.max(forwarded.at + REMIND_AFTER_MS, episode.quietFromMs) : Infinity;
    if (episode.verdict.class === "decision" && remindMs <= (episode.endedMs ?? untilMs)) {
      const plan = planEpisode(episode, { nowMs: remindMs, seen, delegate, leadFor, index });
      if (plan.kind === "reminder") { record(plan, remindMs); lines.push({ nowMs: remindMs, episode, plan, text: describe(plan, null) }); }
    }
  }
  return lines;
}

// The asks `amux asks` shows by default (his and the operator's own, not agents' briefs), read with one rule or the other.
function humanAsks(log, sinceMs, untilMs, waiting) {
  const entries = conversationAskEntries(log, { nowMs: untilMs, ...(waiting ? { waiting } : {}) });
  return filterAskEntries(entries, { sinceMs, humanOnly: true });
}

function reportNeedsYou(log, sinceMs, untilMs, out) {
  const before = humanAsks(log, sinceMs, untilMs, asksHuman).filter((entry) => entry.status === "needs-you");
  const now = humanAsks(log, sinceMs, untilMs, null);
  const after = now.filter((entry) => entry.status === "needs-you");
  const byAgent = (entries) => entries.reduce((counts, { agent }) => counts.set(agent, (counts.get(agent) ?? 0) + 1), new Map());
  const [was, is] = [byAgent(before), byAgent(after)];
  out(`needs-you in asks: before ${before.length}, after ${after.length}`);
  const agents = [...new Set([...was.keys(), ...is.keys()])].sort();
  if (agents.length) out(`  by project: ${agents.map((agent) => `${agent} ${was.get(agent) ?? 0} → ${is.get(agent) ?? 0}`).join(" · ")}`);
  const statusOf = new Map(now.map((entry) => [entry.ledgerId, entry.status]));
  out("former needs-you, by pane and time, with the class it has now:");
  for (const entry of before.sort((left, right) => left.tsMs - right.tsMs)) {
    out(`  ${entry.key} ${clockOf(entry.tsMs)} → ${statusOf.get(entry.ledgerId) ?? "not in the window"}`);
  }
}

/**
 * `d` carries the log path, the roster, the delegate, the park store and `out`. The log is read from two hours before
 * `sinceMs`, so a lead that was active just before the window is not taken for dormant.
 * WHAT: Reports each quiet episode of a window with its action, and needs-you before and after.
 * WHY: Lets a reviewer read the rules against a real day before anything is sent.
 */
export function replayQuiet(d, { sinceMs, untilMs }) {
  const log = readWindow({ path: d.ledgerPath, since: sinceMs - DORMANT_MS, until: untilMs });
  const index = indexLedger(log);
  const parked = new Map();
  const recordOf = (pane) => {
    if (!parked.has(pane)) parked.set(pane, d.parkStore.read(pane.slice(0, pane.lastIndexOf(":")), Number(pane.slice(pane.lastIndexOf(":") + 1))));
    return parked.get(pane);
  };
  const episodes = quietEpisodes(log, { untilMs, operator: d.operator, isParked: (pane, unit) => parkedThen(recordOf(pane), unit.endMs) })
    .filter((episode) => episode.startMs > sinceMs);
  const leadFor = (pane) => leadOf(pane, d.rosterText, { delegate: d.delegate });
  const lines = simulate(episodes, { seen: {}, delegate: d.delegate, leadFor, index, untilMs });

  d.out(`Quiet replay ${range(sinceMs, untilMs)}: reads the log, sends and writes nothing. Park state is the record on disk.`);
  for (const { nowMs, episode, text } of lines) {
    d.out(`${clockOf(nowMs)} ${episode.pane.padEnd(10)} ${episode.verdict.class.padEnd(8)} ${text}`);
  }
  const classes = new Map();
  for (const episode of episodes) classes.set(episode.key, episode.verdict.class);
  const count = (cls) => [...classes.values()].filter((value) => value === cls).length;
  d.out([`${range(sinceMs, untilMs)}`, `${classes.size} episodes`, ...SUMMARY_ORDER.map((cls) => `${LABELS[cls]} ${count(cls)}`)].join(" · "));
  const did = (kind) => lines.filter(({ plan }) => plan.kind === kind).length;
  d.out(`actions: forward ${did("forward")} · reminder ${did("reminder")} · nudge ${did("nudge")} · listed ${did("hands")}`);
  reportNeedsYou(log, sinceMs, untilMs, d.out);
}
