// Bridge side of compaction at a natural pause. Gathers the session evidence a
// pane needs only once it is over budget at a pause, asks the pure decision,
// and either logs what would happen (dry) or compacts through context
// maintenance (on). Every outcome is written once per pause to a JSONL log.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONTEXT_COST_POLICY, PAUSE_COMPACT_POLICY, readContextCostPolicy } from "../policies/context-cost.mjs";
import { latestPaneSessionIdentity } from "../core/native-session-identity.mjs";
import { lastContextCompactAt } from "../core/context-maintenance.mjs";
import { codexBackgroundActivity, latestJournalCompactMs, leaderPanes, oversizeNotice, oversizeWhileWorking, pauseCompactDecision,
  pauseCompactLimit, sessionBackgroundActivity } from "../core/pause-compact.mjs";
import { TERMINAL_DELIVERY_STATES } from "../core/delivery-queue-policy.mjs";
import { SELF_COMPACT_POLICY, formatSelfCompactNotice } from "../core/self-compact.mjs";
import { QUOTA_PARK_ORIGIN, quotaParkContinuation, quotaParkDecision } from "../core/quota-park.mjs";
import { activeClaudeLimitReceipt } from "../core/claude-quota-recovery.mjs";
import { captureJsonlAppendCursor } from "../core/jsonl-append-cursor.mjs";
export { createQuotaParkFacts } from "./quota-park.mjs";
export { createQuotaParkStore } from "../core/quota-park-store.mjs";

const BACKGROUND_BY_ENGINE = Object.freeze({ claude: sessionBackgroundActivity, codex: codexBackgroundActivity });

export const PAUSE_COMPACT_LOG = join(homedir(), ".agentmux", "pause-compact.jsonl");

const appendJsonLine = (path, record) => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
};

/** WHAT: Builds the pause-compaction step of the auto-compact poll. WHY: Keeps the new rule beside the 50-minute rule without changing it. */
export function createPauseCompact({ contextMaintenance, state, modes, policy = PAUSE_COMPACT_POLICY, now = Date.now,
  log = () => {}, record = (line) => appendJsonLine(PAUSE_COMPACT_LOG, line),
  identityFor = latestPaneSessionIdentity, backgroundFor = BACKGROUND_BY_ENGINE, journalCompactFor = latestJournalCompactMs,
  selfRequests = null, notify = async () => {}, cacheLifeMs = readContextCostPolicy().coldMs, deliveryBroker = null,
  parkFor = null, parkStore = null, limitReceiptFor = (engine, paneDir) => (engine === "claude" ? activeClaudeLimitReceipt(paneDir) : null),
  cursorFor = path => captureJsonlAppendCursor("self-compact-request-v1", [path]) }) {
  const lastLogged = new Map();
  // The episode each working pane was asked about, so it hears once until it compacts.
  const asked = new Map();
  // The stop each pane was parked for, so it is parked once per stop.
  const parked = new Map();
  // A dry run compacts nothing, so it remembers its own would-be compacts to show the spacing rule.
  const dryCompacts = new Map();

  function report(paneKey, pauseMs, line) {
    const key = `${pauseMs}:${line.outcome}:${line.cell}`;
    if (lastLogged.get(paneKey) === key) return;
    lastLogged.set(paneKey, key);
    log(`${paneKey} ${line.outcome} (${line.cell}): ${line.detail}`);
    try { record(line); } catch (error) { log(`pause-compact log write failed: ${error.message}`); }
  }

  function lastCompactAt(name, pane, paneKey, sessionPath) {
    const journal = (() => { try { return journalCompactFor(sessionPath); } catch { return null; } })();
    return Math.max(-Infinity, ...[lastContextCompactAt(state, name, pane), journal, dryCompacts.get(paneKey)].filter(Number.isFinite));
  }

  /**
   * WHAT: Considers one pane at this poll. Returns true when it sent a compact, so the 50-minute rule leaves the pane alone.
   * WHY: Keeps the evidence reads (journal tail, /proc) to panes that are over budget at a pause.
   */
  // A self-request ends once it ran or no longer applies; the pane's channel hears how it ended.
  function endRequest(paneKey, request, line) {
    const ending = contextMaintenance.finishSelfRequest?.(request, line) ?? line;
    if (!contextMaintenance.finishSelfRequest) selfRequests.clear(request.agent, request.pane);
    report(paneKey, request.requestedAt, ending);
    const text = formatSelfCompactNotice(paneKey, { ...ending, focus: request.focus });
    Promise.resolve().then(() => notify(request.agent, request.pane, text))
      .catch((error) => log(`${paneKey} self-compact notice failed: ${error.message}`));
  }

  // A turn can run far past its budget before the pause this rule waits for (lsrc:0 2026-10-19: 943k against 400k).
  // The pane is asked to compact itself; the queue holds the ask until no other delivery to it is on its way.
  function askToCompact({ name, pane, paneKey, engine, paneDir, tokens, limit, base }) {
    const identity = identityFor(engine, paneDir);
    const episode = `${identity?.sessionId || "session"}:${lastCompactAt(name, pane, paneKey, identity?.path)}`;
    const jobs = deliveryBroker?.queue?.list?.(name, pane);
    if (asked.get(paneKey) === episode || !jobs) return;
    const idempotencyKey = `pause-compact-oversize:${paneKey}:${episode}`;
    if (!jobs.some(job => job.idempotencyKey === idempotencyKey)) {
      if (jobs.some(job => !TERMINAL_DELIVERY_STATES.has(job.status))) return;
      if (base.mode === "on") deliveryBroker.enqueue({ agentName: name, pane, text: oversizeNotice({ tokens, limit }, policy),
        source: "pause-compact", idempotencyKey });
      report(paneKey, episode, { ...base, limit, cell: "oversize", outcome: base.mode === "on" ? "asked" : "would-ask",
        detail: `working at ${tokens} tokens, ${policy.oversizeFactor} times ${limit} or more` });
    }
    asked.set(paneKey, episode);
  }

  // A pane its account is about to stop for longer than its cache lives files a self-request: the compact runs
  // at its turn end with the usual guards. A pane already stopped at the grace note gets no handoff, since quota
  // recovery resumes it; one stopped at the banner is not parked, since its account refuses the compact.
  async function park({ name, pane, paneKey, engine, paneDir, tokens, quietMs, base }) {
    // The compact pays only while the cache is warm; past its life it would read the whole context cold once more.
    if (!(quietMs < (engine === "codex" ? policy.codexIdleMs : cacheLifeMs))) return false;
    const facts = await parkFor(paneKey);
    const windows = facts?.windows;
    if (!windows?.length) return false;
    const receipt = limitReceiptFor(engine, paneDir);
    if (receipt && receipt.stop !== "grace-note") return false;
    const decision = quotaParkDecision({ engine, windows, graceNote: Boolean(receipt), now: now() });
    const episode = `${decision.window}:${decision.resetAt}`;
    if (!decision.park || parked.get(paneKey) === episode) return false;
    parked.set(paneKey, episode);
    const line = { ...base, cell: "quota-park",
      detail: `${decision.cell}: ${decision.window} window stops it until ${new Date(decision.resetAt).toISOString()}` };
    if (base.mode !== "on") { report(paneKey, episode, { ...line, outcome: "would-park" }); return false; }
    const identity = receipt ? null : identityFor(engine, paneDir);
    const cursor = identity?.path ? cursorFor(identity.path) : null;
    const result = selfRequests.request({ agent: name, pane, tokens, origin: QUOTA_PARK_ORIGIN,
      lastCompactAt: lastCompactAt(name, pane, paneKey, identity?.path),
      ...(identity?.path ? { continuation: quotaParkContinuation(decision), identity: { ...identity, engine, dir: paneDir },
        cursor } : {}) });
    // Quota recovery resumes a Claude pane told to stop here as soon as this account has room again.
    if (result.ok && engine === "claude" && identity?.path) {
      parkStore?.record({ agentName: name, pane, account: facts.account || null, window: decision.window, resetAt: decision.resetAt,
        parkedAt: result.request.requestedAt, identity: { engine, dir: paneDir, sessionId: identity.sessionId, path: identity.path }, cursor });
    }
    report(paneKey, episode, result.ok ? { ...line, outcome: "parked" } : { ...line, outcome: "not-parked", detail: result.detail });
    return result.ok;
  }

  async function consider({ agentConfig, pane, engine, paneDir, status, inCopyMode, contextTokens, lastActivityMs }) {
    const mode = modes[engine] || "off";
    if (mode === "off") return false;
    const name = agentConfig.name;
    const paneKey = `${name}:${pane}`;
    const base = { at: new Date(now()).toISOString(), pane: paneKey, mode, tokens: contextTokens, cell: "self-request" };
    const readRequest = () => selfRequests?.read(name, pane, {
      onExpired: (expired) => report(paneKey, expired.requestedAt, { ...base, outcome: "dropped", detail: "self-request expired unrun after 2 h" }),
    }) ?? null;
    let request = readRequest();
    const quietMs = Number.isFinite(lastActivityMs) ? now() - lastActivityMs : NaN;
    if (!request && parkFor && selfRequests && await park({ name, pane, paneKey, engine, paneDir, tokens: contextTokens, quietMs, base })) {
      request = readRequest();
    }
    if (request && contextMaintenance.selfRequestSuperseded?.(request)) {
      selfRequests.clear(name, pane);
      report(paneKey, request.requestedAt, { ...base, outcome: "dropped", detail: "new input or session superseded the saved handoff" });
      return false;
    }
    // A pane that asked at a stage boundary is compacted from about 80k, the size rule waits for 400k or 700k.
    const limit = request ? SELF_COMPACT_POLICY.minTokens : pauseCompactLimit(agentConfig, pane, policy);
    // Codex's cache lives about 30 minutes, so its idle rule is 25 minutes instead of the shared 50.
    const codexIdle = engine === "codex" ? { idleLimit: policy.codexMinTokens, idleMs: policy.codexIdleMs } : {};
    // A self-request resumes work at once, so its compact is due even on a cold cache.
    const facts = { engine, tokens: contextTokens, limit, ...codexIdle, status, inCopyMode, quietMs,
      cacheLifeMs: request ? null : cacheLifeMs, now: now() };
    const first = pauseCompactDecision(facts, policy);
    if (first.cell === "turn-running" && !request && oversizeWhileWorking(facts, policy)) {
      askToCompact({ name, pane, paneKey, engine, paneDir, tokens: contextTokens, limit, base });
    }
    if (first.action === "none") {
      if (request && first.cell === "within-budget" && mode === "on") {
        endRequest(paneKey, request, { ...base, outcome: "satisfied", detail: `context is ${contextTokens} tokens, under ${limit}` });
      }
      return false;
    }

    const identity = identityFor(engine, paneDir);
    if (!identity?.path) return false;
    const decision = pauseCompactDecision({ ...facts,
      background: backgroundFor[engine]({ sessionPath: identity.path, sessionId: identity.sessionId, paneDir, now: facts.now, policy }),
      lastCompactAt: lastCompactAt(name, pane, paneKey, identity.path) }, policy);
    const line = { at: new Date(facts.now).toISOString(), pane: paneKey, mode, tokens: contextTokens, limit: decision.budget ?? limit,
      leader: leaderPanes(agentConfig).has(pane), quietSec: Math.round(quietMs / 1000),
      cell: request && decision.action === "compact" ? "self-request" : decision.cell, detail: decision.detail };
    if (decision.action === "hold") {
      // A compact within the last 30 minutes already did what the request asked for.
      if (request && decision.cell === "spacing" && mode === "on") {
        endRequest(paneKey, request, { ...line, outcome: "satisfied", cell: "self-request", detail: decision.detail });
        return false;
      }
      report(paneKey, lastActivityMs, { ...line, outcome: "held" });
      return false;
    }

    // The same admission as a live compact: lease, fence, delivery in flight, session, busy screen, composer.
    const result = await contextMaintenance.run(name, pane, { pauseTokens: decision.budget, dry: mode === "dry",
      ...(request ? { focus: request.focus } : {}) });
    if (result.dry) {
      dryCompacts.set(paneKey, facts.now);
      report(paneKey, lastActivityMs, { ...line, outcome: "would-compact", tokens: result.tokens ?? contextTokens });
      return false;
    }
    const outcome = result.compacted ? "compacted" : result.attempted ? "failed" : result.ok ? "skipped" : "refused";
    const ended = { ...line, outcome, cell: request ? "self-request" : result.cell || line.cell, detail: result.reason || line.detail };
    // A refused request (a delivery waiting, the lease busy) stays for the delivery path or the next pause.
    if (request && (result.compacted || result.attempted)) endRequest(paneKey, request, ended);
    else report(paneKey, lastActivityMs, ended);
    return Boolean(result.compacted || result.attempted);
  }

  return { consider };
}

/**
 * WHAT: Builds the compact-before-delivery rule context maintenance applies to a pane idle past its cache's life.
 * WHY: Keeps its limits, switch, guards and log the same as pause compaction's.
 * Claude's cache lives an hour, so 50 minutes and the daytime 80k; Codex's about 30, so 25 minutes and 150k.
 */
export function createColdDeliveryRule({ modes, policy = PAUSE_COMPACT_POLICY, backgroundFor = BACKGROUND_BY_ENGINE,
  record = (line) => appendJsonLine(PAUSE_COMPACT_LOG, line) }) {
  const limits = { claude: { idleMs: CONTEXT_COST_POLICY.idleMs, tokens: CONTEXT_COST_POLICY.maxTokens },
    codex: { idleMs: policy.codexIdleMs, tokens: policy.codexMinTokens } };
  return {
    mode: (engine) => modes[engine] || "off",
    limits: (engine) => limits[engine] || null,
    background: ({ engine, ...facts }) => backgroundFor[engine]?.({ ...facts, policy }) ?? null,
    record,
  };
}
