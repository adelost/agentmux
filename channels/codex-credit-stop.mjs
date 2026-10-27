// A Codex account refuses nothing while paid credits last, so a turn already running when its 5 h window runs out goes on
// drawing credits (claw:5, 27 Oct 2026: 61 model calls, 88.723 credits, 07:56:59Z to 09:01:45Z). The floor holds only new
// deliveries. This guard reads each working Codex pane's own journal, interrupts the turn at the first boundary between tool
// calls, and moves the work to an account with room or holds it for the reset. Credits are used only under AMUX_CODEX_CREDITS=allow.

import { join } from "node:path";
import { listAgents } from "../cli/config.mjs";
import { switchCodexAccounts } from "../cli/codex-account-switch.mjs";
import { createTmuxContext, escapePaneComposer } from "../cli/tmux.mjs";
import { DEFAULT_TMUX_SOCKET } from "../core/runtime-defaults.mjs";
import { accountEngineForCommand } from "../core/runtime-account-profiles.mjs";
import { readCodexAccountQuota } from "../core/codex-account-quota.mjs";
import { codexProfileCatalog, isCodexProfileAuthenticated, selectedCodexProfile } from "../core/codex-profiles.mjs";
import { codexCreditEvidence } from "../core/codex-credit-evidence.mjs";
import { isQuotaFloorHeldJob } from "../core/delivery-wake.mjs";
import { parseJsonlText, readTailWindow } from "../core/jsonl-reader.mjs";
import { latestPaneSessionIdentity } from "../core/native-session-identity.mjs";
import { moveTarget } from "../core/quota-wind-down.mjs";
import { recordPauseCompactLine } from "./pause-compact.mjs";

const RETRY_ESC_MS = 15_000;
const MAX_ESC = 3;
const HELD_MOVE_RETRY_MS = 5 * 60_000;
const SPARE_CACHE_MS = 30_000;
const JOURNAL_TAIL_BYTES = 512 * 1024;
// Esc on an approval prompt would deny it; the turn is waiting there, not drawing credits.
const CODEX_APPROVAL = /Yes, proceed|tell Codex what to do differently/u;
const CREDIT_HELD = /a turn now draws paid credits/u;

const windowName = window => (window === "session" ? "5h" : window);

/** WHAT: Reads AMUX_CODEX_CREDIT_STOP: off, dry (log what it would do) or on (default). WHY: Keeps the guard watchable before it presses Esc. */
export function readCodexCreditStopMode(env = process.env) {
  const mode = env.AMUX_CODEX_CREDIT_STOP || "on";
  if (!["off", "dry", "on"].includes(mode)) throw new Error("AMUX_CODEX_CREDIT_STOP must be off, dry or on");
  return mode;
}

/** WHAT: Formats the text a pane continues from after its turn was stopped for a spent window. WHY: Keeps the task going without repeating a side effect. */
export function creditStopContinuation({ window, resetsAt, moved }) {
  return `[AMUX CODEX CREDIT STOP] Your turn was interrupted: the ${windowName(window)} window of your account is spent until `
    + `${new Date(resetsAt).toISOString().slice(0, 16).replace("T", " ")}Z and paid credits are not allowed.`
    + `${moved ? " This session was moved to an account with room." : ""}`
    + " Continue the task you were on from where you stopped. Do not repeat an external side effect that already has a receipt.";
}

/** WHAT: Builds the guard that stops working Codex turns on a spent window. WHY: Keeps a running turn from drawing paid credits. */
export function createCodexCreditStop({ panes, agent, readEvents, interrupt, spare, requestMove, queue, spentWindows, accountKeyFor,
  creditsAllowed = false, mode = "on", now = Date.now, record = () => {}, log = () => {} }) {
  const episodes = new Map(), heldMoves = new Map(), dry = mode === "dry";
  const line = (paneKey, evidence, fields) => ({ at: new Date(now()).toISOString(), pane: paneKey, cell: "codex-credit-stop",
    window: evidence?.window, resetsAt: evidence && new Date(evidence.resetsAt).toISOString(), balance: evidence?.balance, ...fields });

  async function continueWork({ name, pane, paneKey }, evidence) {
    const target = await Promise.resolve(spare({ name, pane })).catch(error => { log(`${paneKey} spare account: ${error.message}`); return null; });
    const text = creditStopContinuation({ ...evidence, moved: Boolean(target) });
    try {
      if (target) await requestMove({ name, pane, profileId: target.profileId, continuation: text });
      else {
        queue.enqueue({ agentName: name, pane, text, source: "codex-credit-stop",
          idempotencyKey: `codex-credit-stop:${paneKey}:${evidence.turnId}:${evidence.window}:${evidence.resetsAt}` });
      }
      return target ? `moves to ${target.name}` : "waits for the reset";
    } catch (error) {
      log(`${paneKey} continuation not stored: ${error.message}`);
      return `continuation not stored: ${error.message}`;
    }
  }

  async function working(paneInfo) {
    const { name, pane, dir, paneKey } = paneInfo;
    const evidence = codexCreditEvidence(readEvents(dir), { now: now() });
    if (!evidence) return null;
    if (!dry) spentWindows.record(paneKey, { accountKey: await accountKeyFor(name, pane), window: evidence.window, resetsAt: evidence.resetsAt });
    const key = `${paneKey}|${evidence.turnId}|${evidence.window}|${evidence.resetsAt}`;
    const episode = episodes.get(key) || { escapes: 0, lastAt: -Infinity, continued: null, waited: false };
    episodes.set(key, episode);
    if (evidence.toolOpen) {
      if (!episode.waited) record(line(paneKey, evidence, { outcome: "waits-for-tool", detail: "a tool call is open; Esc comes right after its output" }));
      episode.waited = true;
      return "waits-for-tool";
    }
    if (CODEX_APPROVAL.test(await agent.captureScreen(name, pane))) return "approval-prompt";
    if (episode.escapes >= MAX_ESC || now() - episode.lastAt < RETRY_ESC_MS) return "spacing";
    if (dry) {
      episode.escapes = MAX_ESC;
      record(line(paneKey, evidence, { outcome: "would-interrupt", detail: "Esc, then the work moves or waits for the reset" }));
      return "would-interrupt";
    }
    // The work is stored before Esc, so an interrupted turn is never lost.
    episode.continued ??= await continueWork(paneInfo, evidence);
    await interrupt(name, pane);
    episode.escapes += 1;
    episode.lastAt = now();
    record(line(paneKey, evidence, { outcome: "interrupted", detail: `${episode.continued}; Esc ${episode.escapes}` }));
    return "interrupted";
  }

  // A message the credit hold keeps back would wait for the reset; an account with room can serve it now.
  async function heldWork({ name, pane, paneKey }) {
    const held = queue.list(name, pane).find(job => isQuotaFloorHeldJob(job) && CREDIT_HELD.test(job.lastReason || ""));
    if (!held) return null;
    const key = `${paneKey}|${/until (\S+?);/u.exec(held.lastReason)?.[1]}`;
    if (now() - (heldMoves.get(key) ?? -Infinity) < HELD_MOVE_RETRY_MS) return null;
    heldMoves.set(key, now());
    const target = await Promise.resolve(spare({ name, pane })).catch(error => { log(`${paneKey} spare account: ${error.message}`); return null; });
    if (!target) return null;
    if (!dry) await requestMove({ name, pane, profileId: target.profileId, continuation: null });
    record(line(paneKey, null, { outcome: dry ? "would-move-held-work" : "held-work-moves",
      detail: `${held.source} message held by the credit hold; moves to ${target.name}` }));
    return "held-work-moves";
  }

  // The panes are read together: one slow tmux read must not delay the stop of another pane's turn.
  async function tick() {
    if (creditsAllowed || mode === "off") return [];
    const outcomes = await Promise.all(panes().map(async info => {
      const paneInfo = { ...info, paneKey: `${info.name}:${info.pane}` };
      try {
        const outcome = await agent.isBusy(info.name, info.pane) ? await working(paneInfo) : await heldWork(paneInfo);
        return outcome ? { pane: paneInfo.paneKey, outcome } : null;
      } catch (error) { log(`${paneInfo.paneKey} credit stop failed: ${error.message}`); return null; }
    }));
    return outcomes.filter(Boolean);
  }
  return { tick };
}

const engineOf = definition => definition.engine || accountEngineForCommand(definition.cmd);

/** WHAT: Builds and schedules the bridge's credit guard on its Codex panes. WHY: Keeps its wiring out of the bridge entry. */
export function startCodexCreditStop({ agent, deliveryBroker, state, configPath, tmuxSocket = DEFAULT_TMUX_SOCKET, spentWindows,
  creditsAllowed, mode = readCodexCreditStopMode(), pollMs = 10_000, now = Date.now, record = recordPauseCompactLine }) {
  let context = null, running = null;
  // Panes on one spent account ask for a spare together; one fresh reading answers them all.
  const spares = new Map();
  const tmuxContext = () => (context ||= { ...createTmuxContext(tmuxSocket, configPath), agent, state, configPath });
  const currentProfile = (name, pane) => selectedCodexProfile(state, name, pane, codexProfileCatalog());
  const guard = createCodexCreditStop({
    panes: () => listAgents(configPath).filter(entry => entry.backend !== "native").flatMap(entry => entry.panes.flatMap((definition, index) =>
      engineOf(definition) === "codex" ? [{ name: entry.name, pane: index, dir: join(entry.dir, ".agents", String(index)) }] : [])),
    agent,
    readEvents: dir => {
      const path = latestPaneSessionIdentity("codex", dir)?.path;
      return path ? parseJsonlText(readTailWindow(path, JOURNAL_TAIL_BYTES).text) : [];
    },
    interrupt: (name, pane) => escapePaneComposer(tmuxContext(), name, pane, { actor: "codex-credit-stop" }),
    spare: ({ name, pane }) => {
      const current = currentProfile(name, pane), cached = spares.get(current.id);
      if (cached && now() - cached.at < SPARE_CACHE_MS) return cached.found;
      const others = codexProfileCatalog().filter(profile => profile.id !== current.id && isCodexProfileAuthenticated(profile));
      const found = Promise.all(others.map(profile => readCodexAccountQuota(profile)))
        .then(accounts => moveTarget({ engine: "codex", accounts, from: { key: current.key }, readAfter: now() - 10 * 60_000 }));
      spares.set(current.id, { at: now(), found });
      return found;
    },
    requestMove: ({ name, pane, profileId, continuation }) => switchCodexAccounts(
      { ...tmuxContext(), deliveryQueue: deliveryBroker.queue }, [`codex:${profileId}`, name, "-p", String(pane)],
      { continuation, output: () => {} }),
    queue: deliveryBroker.queue, spentWindows, accountKeyFor: (name, pane) => currentProfile(name, pane).key,
    creditsAllowed, mode, now, record, log: message => console.log(`codex-credit-stop | ${message}`),
  });
  console.log(`codex-credit-stop | ${creditsAllowed ? "off, paid credits allowed by AMUX_CODEX_CREDITS=allow" : mode}, every ${pollMs / 1000} s`);
  const tick = () => (running ||= guard.tick().finally(() => { running = null; }));
  const timer = setInterval(() => tick().catch(error => console.log(`codex-credit-stop | tick failed: ${error.message}`)), pollMs);
  timer.unref?.();
  return { tick };
}
