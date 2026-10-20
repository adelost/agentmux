// `amux quiet`: why a pane went quiet, and the one obvious action (docs/DESIGN-quiet-panes.md). Run by the stall-watch
// cron every 2 minutes as `amux quiet --act`. Rules, no model: a login or a key is his hands and goes on a list; a
// decision the delegate can make is forwarded once, with one reminder; work left with no blocker is one nudge to the
// pane's lead; everything else sleeps. Every message leaves through `sendThroughAmux`, the one send call of this file.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFlags } from "./command-args.mjs";
import { replayQuiet } from "./quiet-replay.mjs";
import { getPaneStatus, sendToPane } from "./tmux.mjs";
import { defaultAskLedgerPath, readWindow } from "../core/ask-ledger.mjs";
import { isLiveStatus } from "../core/pane-status.mjs";
import { parseSinceArg } from "../core/jsonl-reader.mjs";
import { createQuotaParkStore } from "../core/quota-park-store.mjs";
import { SCAN_MS, createQuietStore, indexLedger, openEpisodes, quietEpisodes } from "../core/quiet-episodes.mjs";
import { DEFAULT_DELEGATE, handsLine, leadOf, nextHands, planEpisode } from "../core/quiet-plan.mjs";
import { operatorName } from "../core/runtime-defaults.mjs";

const FLAGS = { act: "boolean", replay: "boolean", hands: "boolean", since: "string", until: "string", help: "boolean", h: "boolean" };
const SEND_WAIT_MS = 4_000;

const USAGE = `Usage: amux quiet --act
       amux quiet --replay --since ISO --until ISO
       amux quiet --hands

Why a pane went quiet, and the one obvious action, from the conversation log. Rules, no model call.
  --act      Look at the last 6 hours once (the stall-watch cron runs it every 2 minutes). A decision the delegate can make
             is forwarded to the delegate (lsrc:0, or AMUX_QUIET_DELEGATE) with one reminder after 30 minutes. Work left with
             no blocker is one nudge to the pane's lead (ROSTER.md). A login, card, key, hardware or a test only the operator
             can do goes on the hands list and gets no message. Anything else sleeps. One message per pane and episode, never
             to a pane with no ledger row in 2 hours, never about a pane that is working now, never resent after an unknown
             outcome. AMUX_QUIET=0 prints what it would send and sends and marks nothing.
  --replay   Read the log between --since and --until (ISO), print each episode's class and the action it would take, and
             needs-you before and after. Sends and writes nothing.
  --hands    Print the panes that wait for the operator's hands.

Environment: AMUX_QUIET=0 (nothing is sent), AMUX_QUIET_DELEGATE (default lsrc:0), AMUX_ROSTER_PATH (default
~/.agentmux/ROSTER.md), AMUX_QUIET_SEEN_PATH and AMUX_QUIET_HANDS_PATH (default ~/.agentmux/quiet-seen.json and quiet-hands.json).`;

const splitPane = (pane) => [pane.slice(0, pane.lastIndexOf(":")), Number(pane.slice(pane.lastIndexOf(":") + 1))];

function readRoster(env) {
  try { return readFileSync(env.AMUX_ROSTER_PATH || join(homedir(), ".agentmux", "ROSTER.md"), "utf8"); } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

/**
 * `sent` covers a message that was delivered or is durably queued, `unknown` one whose delivery could not be verified (it
 * is never sent again), and `failed` one the queue refused or that threw before it was queued.
 * WHAT: Routes one quiet message through amux's own send path with its idempotency key.
 * WHY: Keeps every message on the delivery queue, so a double cron run cannot send it twice.
 */
export async function sendThroughAmux(ctx, { agent, pane, text, key }, deliverTo = sendToPane) {
  try {
    const result = await deliverTo(ctx, agent, pane, text, { idempotencyKey: key, waitMs: SEND_WAIT_MS });
    if (result?.unverified) return { outcome: "unknown" };
    return result?.delivered ? { outcome: "sent" } : { outcome: "failed", detail: result?.reason ?? "blocked" };
  } catch (error) {
    return { outcome: "failed", detail: error.message };
  }
}

function resolveDeps(ctx, deps) {
  const env = deps.env ?? process.env;
  return {
    env,
    now: deps.now ?? Date.now,
    out: deps.out ?? ((line) => console.log(line)),
    ledgerPath: deps.ledgerPath ?? defaultAskLedgerPath(),
    store: deps.store ?? createQuietStore(),
    parkStore: deps.parkStore ?? createQuotaParkStore(),
    paneStatus: deps.paneStatus ?? ((agent, pane) => getPaneStatus(ctx, agent, pane)),
    send: deps.send ?? ((message) => sendThroughAmux(ctx, message)),
    rosterText: deps.rosterText ?? readRoster(env),
    delegate: env.AMUX_QUIET_DELEGATE || DEFAULT_DELEGATE,
    operator: operatorName(env),
  };
}

const planWords = (plan) => `${plan.kind} to ${plan.target} about ${plan.episode.pane}`;

async function deliver(d, plan, nowMs) {
  const [agent, pane] = splitPane(plan.target);
  const { outcome, detail } = await d.send({ agent, pane, text: plan.text, key: plan.key });
  d.store.markSeen(plan.key, {
    at: nowMs, state: outcome, target: plan.target, kind: plan.kind, since: plan.episode.sinceMs,
    ...(outcome === "failed" ? { attempts: plan.attempts } : {}),
  });
  return { outcome, line: `${planWords(plan)} (${plan.key}): ${outcome}${detail ? `, ${detail}` : ""}` };
}

async function actQuiet(d) {
  const nowMs = d.now();
  const dry = d.env.AMUX_QUIET === "0";
  const log = readWindow({ path: d.ledgerPath, since: nowMs - SCAN_MS, until: nowMs });
  const index = indexLedger(log);
  const parked = new Map();
  const isParked = (pane) => {
    if (!parked.has(pane)) parked.set(pane, d.parkStore.read(...splitPane(pane))?.state === "parked");
    return parked.get(pane);
  };
  const open = openEpisodes(quietEpisodes(log, { untilMs: nowMs, operator: d.operator, isParked }));
  const context = { nowMs, seen: d.store.seen(), delegate: d.delegate, leadFor: (pane) => leadOf(pane, d.rosterText, { delegate: d.delegate }), index };
  const lines = dry ? ["AMUX_QUIET=0: nothing is sent or marked"] : [];
  const listed = [];
  const done = { forward: 0, reminder: 0, nudge: 0 };
  for (const plan of open.map((episode) => planEpisode(episode, context))) {
    const { pane, agent, paneIndex, verdict } = plan.episode;
    if (plan.kind === "skip") {
      if (plan.notable) lines.push(`${pane} ${verdict.class}: ${plan.reason}`);
    } else if (isLiveStatus(await d.paneStatus(agent, paneIndex))) {
      lines.push(`${pane} ${verdict.class}: working now, so no ${plan.kind}`);
    } else if (plan.kind === "hands") {
      listed.push(plan);
    } else if (dry) {
      lines.push(`AMUX_QUIET=0: would send ${planWords(plan)}: ${plan.text}`);
    } else {
      const { outcome, line } = await deliver(d, plan, nowMs);
      lines.push(line);
      if (outcome !== "failed") done[plan.kind] += 1;
    }
  }
  const previous = d.store.hands();
  const next = nextHands(previous, { listed, open, index });
  if (JSON.stringify(next) !== JSON.stringify(previous)) d.store.setHands(next);
  if (lines.length) {
    d.out([...lines, `quiet --act: ${open.length} open · forwarded ${done.forward} · reminded ${done.reminder} · nudged ${done.nudge} · hands listed ${listed.length}`].join("\n"));
  }
}

function printHands(d) {
  const entries = Object.entries(d.store.hands()).sort(([, left], [, right]) => left.since - right.since);
  if (!entries.length) return d.out(`No pane waits for ${d.operator}'s hands.`);
  for (const [pane, entry] of entries) d.out(handsLine({ pane, ...entry }));
}

function replayWindow(flags) {
  const [since, until] = [parseSinceArg(flags.since), parseSinceArg(flags.until)];
  if (!since || !until || since >= until) throw new Error("amux quiet --replay needs --since and --until as ISO times, --since before --until");
  return { sinceMs: since.getTime(), untilMs: until.getTime() };
}

/**
 * `deps` lets a test replace the clock, the ledger, the send, the live status and the stores; a run from the shell uses
 * the real ones. `--act` is the cron's call, `--replay` reads and prints, `--hands` prints the list.
 * WHAT: Dispatches `amux quiet` to its act, replay or hands mode.
 * WHY: Keeps the cron, the replay and the list on one command with one help text.
 */
export async function cmdQuiet(args, ctx = {}, deps = {}) {
  const { flags } = parseFlags(args, FLAGS);
  const modes = ["act", "replay", "hands"].filter((mode) => flags[mode]);
  const out = deps.out ?? ((line) => console.log(line));
  if (flags.help || flags.h) return out(USAGE);
  if (modes.length !== 1) throw new Error(`amux quiet takes exactly one of --act, --replay, --hands\n\n${USAGE}`);
  const d = resolveDeps(ctx, deps);
  if (flags.hands) return printHands(d);
  if (flags.replay) return replayQuiet(d, replayWindow(flags));
  return actQuiet(d);
}
