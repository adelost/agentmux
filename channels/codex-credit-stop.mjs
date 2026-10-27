// A Codex account refuses nothing while paid credits last, so a turn already running when its 5 h window runs out goes on
// drawing credits (claw:5, 27 Oct 2026: 61 model calls, 88.723 credits, 07:56:59Z to 09:01:45Z). The floor holds only new
// deliveries. This guard reads each working Codex pane's own journal, interrupts the turn at the first boundary between tool
// calls, and moves the work to an account with room or holds it for the reset. Credits are used only under AMUX_CODEX_CREDITS=allow.
// lsrc:0 for api:0, 2026-10-27: Mattias's own turn is never stopped. Every case, stopped or left running, goes to the credit
// log with its credits before and after, and `amux quota` reads the week's sum.

import { join } from "node:path";
import { listAgents } from "../cli/config.mjs";
import { switchCodexAccounts } from "../cli/codex-account-switch.mjs";
import { createTmuxContext, escapePaneComposer } from "../cli/tmux.mjs";
import { DEFAULT_TMUX_SOCKET } from "../core/runtime-defaults.mjs";
import { accountEngineForCommand } from "../core/runtime-account-profiles.mjs";
import { readCodexAccountQuota } from "../core/codex-account-quota.mjs";
import { codexProfileCatalog, isCodexProfileAuthenticated, selectedCodexProfile } from "../core/codex-profiles.mjs";
import { codexCreditEvidence, codexLastBalance } from "../core/codex-credit-evidence.mjs";
import { appendCreditStopLine } from "../core/codex-credit-log.mjs";
import { ownerOfTurn } from "../core/codex-turn-owner.mjs";
import { readWindow } from "../core/ask-ledger.mjs";
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
// A turn whose start left the tail is looked up once, as far back as the capacity recovery looks.
const JOURNAL_DEEP_BYTES = 8 * 1024 * 1024;
const ASK_LOOKBACK_MS = 2 * 3_600_000;
const credits = (before, after) => (Number.isFinite(before) && Number.isFinite(after) ? Number((before - after).toFixed(3)) : null);
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
export function createCodexCreditStop({ panes, agent, readEvents, readEventsDeep = readEvents, ownerOf, interrupt, spare, requestMove, queue,
  spentWindows, accountKeyFor, creditsAllowed = false, mode = "on", now = Date.now, record = () => {}, ledger = () => {}, notify = async () => {},
  log = () => {} }) {
  const episodes = new Map(), heldMoves = new Map(), longTurns = new Map(), openCases = new Map(), dry = mode === "dry";
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

  // A case stays open until its turn ends; then the journal's last balance closes it, which includes the call in flight at Esc.
  async function settle({ dir, paneKey }, keepKey = null) {
    const open = openCases.get(paneKey);
    if (!open?.size) return;
    const after = codexLastBalance(readEvents(dir));
    for (const [key, entry] of open) {
      if (key === keepKey) continue;
      ledger({ at: new Date(now()).toISOString(), case: key, pane: paneKey, kind: "settled", window: entry.window, balanceBefore: entry.before,
        balanceAfter: after, creditsDrawn: credits(entry.before, after) });
      open.delete(key);
    }
  }

  function openCase(paneKey, key, kind, evidence, ownerTurn) {
    const drawn = credits(evidence.balanceAtFirstSpent, evidence.balance);
    ledger({ at: new Date(now()).toISOString(), case: key, pane: paneKey, kind, window: evidence.window, resetsAt: new Date(evidence.resetsAt).toISOString(),
      balanceBefore: evidence.balanceAtFirstSpent, balanceNow: evidence.balance, creditsDrawn: drawn, ...(ownerTurn === "unknown" ? { ownerTurn } : {}) });
    if (!openCases.has(paneKey)) openCases.set(paneKey, new Map());
    openCases.get(paneKey).set(key, { before: evidence.balanceAtFirstSpent, window: evidence.window });
  }

  // The start of a long turn may lie before the tail; one deeper read finds who began it, and the pane's idle moment forgets it.
  function withLongTurn({ dir, paneKey }, evidence) {
    if (evidence.prompts !== null) return evidence;
    const key = `${paneKey}|${evidence.window}|${evidence.resetsAt}`;
    if (!longTurns.has(key)) longTurns.set(key, codexCreditEvidence(readEventsDeep(dir), { now: now() }));
    const deep = longTurns.get(key);
    return deep ? { ...evidence, turnId: deep.turnId, startedAt: deep.startedAt, prompts: deep.prompts, balanceAtFirstSpent: deep.balanceAtFirstSpent } : evidence;
  }

  async function working(paneInfo) {
    const { name, pane, dir, paneKey } = paneInfo;
    const first = codexCreditEvidence(readEvents(dir), { now: now() });
    if (!first) { await settle(paneInfo); return null; }
    const evidence = withLongTurn(paneInfo, first);
    if (!dry) spentWindows.record(paneKey, { accountKey: await accountKeyFor(name, pane), window: evidence.window, resetsAt: evidence.resetsAt });
    const key = `${paneKey}|${evidence.turnId}|${evidence.window}|${evidence.resetsAt}`;
    await settle(paneInfo, key);
    const episode = episodes.get(key) || { escapes: 0, lastAt: -Infinity, continued: null, waited: false, judged: -1, owner: null };
    episodes.set(key, episode);
    // The prompts are judged again only when a new one has arrived; the ledger read behind it is not free.
    if (episode.judged !== (evidence.prompts?.length ?? -1)) {
      episode.owner = await ownerOf({ name, pane, prompts: evidence.prompts, startedAt: evidence.startedAt });
      episode.judged = evidence.prompts?.length ?? -1;
    }
    // His turn, or one nobody can place, is never stopped; it is logged so the week's credits can be read.
    if (episode.owner !== false) {
      if (!episode.logged) {
        if (!dry) openCase(paneKey, key, "owner-turn", evidence, episode.owner === null ? "unknown" : true);
        record(line(paneKey, evidence, { outcome: "owner-turn-continues", detail: episode.owner === null ? "nobody can place the turn" : "his turn is never stopped" }));
        episode.logged = true;
      }
      // No Esc, but he hears at once and decides himself (lsrc:0 for api:0, 2026-10-27); a failed send is tried again at the next tick.
      if (!episode.announced && !dry) {
        const drawn = credits(evidence.balanceAtFirstSpent, evidence.balance) ?? 0;
        try {
          await notify(name, pane, `${paneKey} drar credits nu (${String(Number(drawn.toFixed(2))).replace(".", ",")} hittills)`);
          episode.announced = true;
        } catch (error) { log(`${paneKey} credit notice not sent: ${error.message}`); }
      }
      return "owner-turn-continues";
    }
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
    if (episode.escapes === 1) openCase(paneKey, key, "esc", evidence, true);
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
        const busy = await agent.isBusy(info.name, info.pane);
        if (!busy) { await settle(paneInfo); for (const key of longTurns.keys()) if (key.startsWith(`${paneInfo.paneKey}|`)) longTurns.delete(key); }
        const outcome = busy ? await working(paneInfo) : await heldWork(paneInfo);
        return outcome ? { pane: paneInfo.paneKey, outcome } : null;
      } catch (error) { log(`${paneInfo.paneKey} credit stop failed: ${error.message}`); return null; }
    }));
    return outcomes.filter(Boolean);
  }
  return { tick };
}

const readJournal = (dir, bytes) => {
  const path = latestPaneSessionIdentity("codex", dir)?.path;
  return path ? parseJsonlText(readTailWindow(path, bytes).text) : [];
};
const engineOf = definition => definition.engine || accountEngineForCommand(definition.cmd);

/** WHAT: Builds and schedules the bridge's credit guard on its Codex panes. WHY: Keeps its wiring out of the bridge entry. */
export function startCodexCreditStop({ agent, deliveryBroker, state, configPath, tmuxSocket = DEFAULT_TMUX_SOCKET, spentWindows,
  creditsAllowed, mode = readCodexCreditStopMode(), pollMs = 10_000, now = Date.now, record = recordPauseCompactLine,
  ledger = appendCreditStopLine, notify }) {
  let context = null, running = null;
  // Panes on one spent account ask for a spare together; one fresh reading answers them all.
  const spares = new Map();
  const tmuxContext = () => (context ||= { ...createTmuxContext(tmuxSocket, configPath), agent, state, configPath });
  const currentProfile = (name, pane) => selectedCodexProfile(state, name, pane, codexProfileCatalog());
  const guard = createCodexCreditStop({
    panes: () => listAgents(configPath).filter(entry => entry.backend !== "native").flatMap(entry => entry.panes.flatMap((definition, index) =>
      engineOf(definition) === "codex" ? [{ name: entry.name, pane: index, dir: join(entry.dir, ".agents", String(index)) }] : [])),
    agent,
    readEvents: dir => readJournal(dir, JOURNAL_TAIL_BYTES),
    readEventsDeep: dir => readJournal(dir, JOURNAL_DEEP_BYTES),
    ownerOf: ({ name, pane, prompts, startedAt }) => ownerOfTurn({ prompts, asks: prompts?.length
      ? readWindow({ since: (startedAt ?? now()) - ASK_LOOKBACK_MS, agents: [name] }).asks.filter(ask => ask.pane === pane) : [] }),
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
    creditsAllowed, mode, now, record, ledger, notify, log: message => console.log(`codex-credit-stop | ${message}`),
  });
  console.log(`codex-credit-stop | ${creditsAllowed ? "off, paid credits allowed by AMUX_CODEX_CREDITS=allow" : mode}, every ${pollMs / 1000} s`);
  const tick = () => (running ||= guard.tick().finally(() => { running = null; }));
  const timer = setInterval(() => tick().catch(error => console.log(`codex-credit-stop | tick failed: ${error.message}`)), pollMs);
  timer.unref?.();
  return { tick };
}
