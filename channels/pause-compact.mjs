// Bridge side of compaction at a natural pause. Gathers the session evidence a
// pane needs only once it is over budget at a pause, asks the pure decision,
// and either logs what would happen (dry) or compacts through context
// maintenance (on). Every outcome is written once per pause to a JSONL log.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONTEXT_COST_POLICY, PAUSE_COMPACT_POLICY, readContextCostPolicy } from "../policies/context-cost.mjs";
import { latestPaneSessionIdentity } from "../core/native-session-identity.mjs";
import { contextMaintenanceAttempt, lastContextCompactAt } from "../core/context-maintenance.mjs";
import { codexBackgroundActivity, latestJournalCompactMs, leaderPanes, oversizeNotice, oversizeWhileWorking, pauseCompactDecision,
  pauseCompactLimit, sessionBackgroundActivity } from "../core/pause-compact.mjs";
import { TERMINAL_DELIVERY_STATES } from "../core/delivery-queue-policy.mjs";
import { SELF_COMPACT_POLICY, formatSelfCompactNotice } from "../core/self-compact.mjs";
import { QUOTA_FLOOR_DEFAULT_PERCENT, QUOTA_PARK_ORIGIN, QUOTA_PARK_POLICY, codexCreditHold, quotaParkContinuation,
  quotaParkDecision, quotaStopEpisode } from "../core/quota-park.mjs";
import { activeClaudeLimitReceipt } from "../core/claude-quota-recovery.mjs";
import { captureJsonlAppendCursor } from "../core/jsonl-append-cursor.mjs";
import { isLiveStatus } from "../core/pane-status.mjs";
import { compactPays, moveTarget, QUOTA_WIND_DOWN_ORIGIN, readWindDownMode, windDownNotice, windDownStage } from "../core/quota-wind-down.mjs";
export { createQuotaParkFacts } from "./quota-park.mjs";
export { createQuotaParkStore } from "../core/quota-park-store.mjs";
export { codexCreditsAllowed, quotaFloorPercent } from "../core/quota-park.mjs";

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
  parkFor = null, parkStore = null, floorPercent = QUOTA_FLOOR_DEFAULT_PERCENT, creditsAllowed = false,
  limitReceiptFor = (engine, paneDir) => (engine === "claude" ? activeClaudeLimitReceipt(paneDir) : null),
  windDownMode = readWindDownMode(), windDownMove = process.env.AMUX_QUOTA_WIND_DOWN_MOVE !== "false",
  moveAfterWindDown = null, compactReceiptFor = (name, pane, identity) => contextMaintenanceAttempt(state, name, pane, identity, now()),
  cursorFor = path => captureJsonlAppendCursor("self-compact-request-v1", [path]) }) {
  if (!["off", "dry", "on"].includes(windDownMode)) throw new Error("AMUX_QUOTA_WIND_DOWN must be off, dry or on");
  const lastLogged = new Map();
  // The episode each working pane was asked about, so it hears once until it compacts.
  const asked = new Map();
  // The stop each pane was parked for, so it is parked once per stop.
  const parked = new Map();
  const windDownEpisodes = new Map();
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
  async function park({ name, pane, paneKey, engine, paneDir, tokens, quietMs, status, base }) {
    // The compact pays only while the cache is warm; past its life it would read the whole context cold once more.
    if (!(quietMs < (engine === "codex" ? policy.codexIdleMs : cacheLifeMs))) return false;
    const facts = await parkFor(paneKey);
    const windows = facts?.windows;
    if (!windows?.length) return false;
    const receipt = limitReceiptFor(engine, paneDir);
    if (receipt && receipt.stop !== "grace-note") return false;
    // The park compacts at the floor, where new automatic work stops, or ahead of a window forecast to run out.
    const decision = quotaParkDecision({ engine, windows, graceNote: Boolean(receipt), graceNoteAt: receipt?.observedAt,
      working: isLiveStatus(status), lastActivityAt: now() - quietMs, now: now() }, { ...QUOTA_PARK_POLICY, leftPercent: floorPercent });
    const episode = quotaStopEpisode(decision.window, decision.resetAt);
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
        leftPercent: decision.leftPercent, parkedAt: result.request.requestedAt,
        identity: { engine, dir: paneDir, sessionId: identity.sessionId, path: identity.path }, cursor });
    }
    report(paneKey, episode, result.ok ? { ...line, outcome: "parked" } : { ...line, outcome: "not-parked", detail: result.detail });
    return result.ok;
  }

  // lsrc:0 2026-10-20: two Codex panes compacted on paid credits after Codex A's 5 h window was spent at about 17:35Z.
  // Codex works on past a spent window on credits, so its compact waits for the reset like any automatic turn.
  async function creditHeld(paneKey, base) {
    const facts = await parkFor(paneKey);
    const hold = codexCreditHold({ windows: facts?.windows, provider: facts?.account?.provider, creditsAllowed, now: now() });
    if (!hold) return false;
    report(paneKey, hold.resetsAt, { ...base, cell: "credit-hold", outcome: "held",
      detail: `${facts.account?.name || "its account"} has spent its ${hold.window} window until ${hold.resetsAt}` });
    return true;
  }

  async function windDownStep({ name, pane, paneKey, engine, paneDir, tokens, lastActivityMs, status, base }) {
    if (windDownMode === "off" || !parkFor || !["claude", "codex"].includes(engine)) return false;
    const facts = await parkFor(paneKey), stage = windDownStage({ ...facts, now: now() });
    if (!stage) return false;
    const episodeKey = `${paneKey}|${quotaStopEpisode(stage.window, stage.resetAt)}`;
    if (windDownEpisodes.get(paneKey)?.key !== episodeKey) {
      const lastMoveAt = windDownEpisodes.get(paneKey)?.lastMoveAt;
      windDownEpisodes.set(paneKey, { key: episodeKey, beganAt: stage.noticeAt, lastMoveAt });
      if (Number.isFinite(lastMoveAt) && now() - lastMoveAt < 30 * 60_000) {
        report(paneKey, episodeKey, { ...base, cell: "quota-wind-down", outcome: "wind-down-soon-after-move",
          detail: `${Math.round((now() - lastMoveAt) / 60_000)} min since the previous wind-down move` });
      }
    }
    const episode = windDownEpisodes.get(paneKey), working = isLiveStatus(status);
    const line = { ...base, mode: windDownMode, cell: "quota-wind-down", detail: `${stage.window} window, ${stage.leftPercent.toFixed(1)} % left` };
    const send = (percent, flag, action) => {
      if (!working || episode[flag]) return;
      const idempotencyKey = `quota-wind-down:${percent}:${paneKey}:${episodeKey}`;
      const existing = deliveryBroker?.queue?.list(name, pane).some(job => job.idempotencyKey === idempotencyKey);
      if (!existing) {
        if (windDownMode === "on" && !deliveryBroker) return;
        if (windDownMode === "on") deliveryBroker.enqueue({ agentName: name, pane, source: QUOTA_WIND_DOWN_ORIGIN,
          text: windDownNotice({ ...stage, account: facts.account.name }), idempotencyKey });
        report(paneKey, episodeKey, { ...line, outcome: windDownMode === "dry" ? `would-${action}` : `wind-down-${action}` });
      }
      episode[flag] = true;
    };
    if (stage.stage === "notice") send(5, "noticed", "notice");
    if (stage.stage === "nudge") send(3, "nudged", "nudge");
    const identity = identityFor(engine, paneDir);
    const receipt = identity && compactReceiptFor(name, pane, identity);
    const verified = receipt?.status === "VERIFIED" && receipt.sessionId === identity.sessionId
      && (receipt.finishedAt ?? receipt.at) >= episode.beganAt;
    const readAfter = Math.max(verified ? receipt.finishedAt ?? receipt.at : -Infinity, now() - 10 * 60_000);
    const target = windDownMove ? moveTarget({ engine, accounts: facts.accounts, from: facts.account, readAfter }) : null;
    if (!verified && !episode.requested && selfRequests && !selfRequests.read(name, pane)
        && compactPays({ ...stage, engine, working, lastActivityAt: lastActivityMs, target })) {
      const limit = limitReceiptFor(engine, paneDir);
      if (!limit || limit.stop === "grace-note") {
        // Dry mode names the compacts it would request, so a live stop can be checked against the replay.
        const result = windDownMode === "dry" ? { ok: true } : selfRequests.request({ agent: name, pane, tokens,
          origin: QUOTA_WIND_DOWN_ORIGIN, lastCompactAt: lastCompactAt(name, pane, paneKey, identity?.path) });
        episode.requested = result.ok;
        const outcome = windDownMode === "dry" ? "would-compact" : result.ok ? "wind-down-requested" : "wind-down-held";
        report(paneKey, episodeKey, { ...line, outcome, detail: result.detail || line.detail });
      }
    }
    if (!verified || !target || working || status !== "idle" || episode.moved) return false;
    if (windDownMode === "dry") {
      report(paneKey, episodeKey, { ...line, outcome: "would-move", detail: `${facts.account.name} -> ${target.name}` });
      return false;
    }
    if (!moveAfterWindDown) return false;
    const result = await moveAfterWindDown({ agentName: name, pane, engine, target, from: facts.account,
      episode: episodeKey, beganAt: episode.beganAt, identity });
    episode.moved = Boolean(result?.moved);
    if (episode.moved) {
      episode.lastMoveAt = now();
      report(paneKey, episodeKey, { ...line, outcome: "wind-down-moved", detail: `${facts.account.name} -> ${target.name}` });
    }
    return episode.moved;
  }

  async function consider({ agentConfig, pane, engine, paneDir, status, inCopyMode, contextTokens, lastActivityMs }) {
    let mode = modes[engine] || "off";
    const name = agentConfig.name;
    const paneKey = `${name}:${pane}`;
    const base = { at: new Date(now()).toISOString(), pane: paneKey, mode, tokens: contextTokens, cell: "self-request" };
    if (engine === "codex" && parkFor && (mode !== "off" || windDownMode !== "off") && await creditHeld(paneKey, base)) return false;
    if (await windDownStep({ name, pane, paneKey, engine, paneDir, tokens: contextTokens, lastActivityMs, status, base })) return true;
    const readRequest = () => selfRequests?.read(name, pane, {
      onExpired: (expired) => report(paneKey, expired.requestedAt, { ...base, outcome: "dropped", detail: "self-request expired unrun after 2 h" }),
    }) ?? null;
    let request = readRequest();
    if (request?.origin === QUOTA_WIND_DOWN_ORIGIN) mode = windDownMode;
    if (mode === "off") return false;
    base.mode = mode;
    const quietMs = Number.isFinite(lastActivityMs) ? now() - lastActivityMs : NaN;
    if (!request && parkFor && selfRequests && await park({ name, pane, paneKey, engine, paneDir, tokens: contextTokens, quietMs, status, base })) {
      request = readRequest();
    }
    const parking = request?.origin === QUOTA_PARK_ORIGIN || request?.origin === QUOTA_WIND_DOWN_ORIGIN;
    const windDownRequested = request?.origin === QUOTA_WIND_DOWN_ORIGIN;
    const decisionPolicy = windDownRequested ? { ...policy, settleMs: 0 } : policy;
    if (request && contextMaintenance.selfRequestSuperseded?.(request)) {
      selfRequests.clear(name, pane);
      // New input outdates the park's handoff, not its compact: the next turn end parks the pane again for this stop.
      if (parking) parked.delete(paneKey);
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
    const first = pauseCompactDecision(facts, decisionPolicy);
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
      // A park compacts while a subagent or job still works: the stop turns the context cold before their results land.
      background: parking ? null : backgroundFor[engine]({ sessionPath: identity.path, sessionId: identity.sessionId, paneDir, now: facts.now, policy }),
      lastCompactAt: lastCompactAt(name, pane, paneKey, identity.path) }, decisionPolicy);
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
      ...(windDownRequested ? { pauseSettleMs: 0 } : {}),
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
