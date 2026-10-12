// Bridge side of compaction at a natural pause. Gathers the session evidence a
// pane needs only once it is over budget at a pause, asks the pure decision,
// and either logs what would happen (dry) or compacts through context
// maintenance (on). Every outcome is written once per pause to a JSONL log.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONTEXT_COST_POLICY, PAUSE_COMPACT_POLICY } from "../policies/context-cost.mjs";
import { latestPaneSessionIdentity } from "../core/native-session-identity.mjs";
import { lastContextCompactAt } from "../core/context-maintenance.mjs";
import { codexBackgroundActivity, latestJournalCompactMs, leaderPanes, pauseCompactDecision, pauseCompactLimit,
  sessionBackgroundActivity } from "../core/pause-compact.mjs";
import { SELF_COMPACT_POLICY, formatSelfCompactNotice } from "../core/self-compact.mjs";

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
  selfRequests = null, notify = async () => {} }) {
  const lastLogged = new Map();
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

  async function consider({ agentConfig, pane, engine, paneDir, status, inCopyMode, contextTokens, lastActivityMs }) {
    const mode = modes[engine] || "off";
    if (mode === "off") return false;
    const name = agentConfig.name;
    const paneKey = `${name}:${pane}`;
    const base = { at: new Date(now()).toISOString(), pane: paneKey, mode, tokens: contextTokens, cell: "self-request" };
    const request = selfRequests?.read(name, pane, {
      onExpired: (expired) => report(paneKey, expired.requestedAt, { ...base, outcome: "dropped", detail: "self-request expired unrun after 2 h" }),
    }) ?? null;
    if (request && contextMaintenance.selfRequestSuperseded?.(request)) {
      selfRequests.clear(name, pane);
      report(paneKey, request.requestedAt, { ...base, outcome: "dropped", detail: "new input or session superseded the saved handoff" });
      return false;
    }
    // A pane that asked at a stage boundary is compacted from about 80k, the size rule waits for 400k or 700k.
    const limit = request ? SELF_COMPACT_POLICY.minTokens : pauseCompactLimit(agentConfig, pane, policy);
    const quietMs = Number.isFinite(lastActivityMs) ? now() - lastActivityMs : NaN;
    // Codex's cache lives about 30 minutes, so its idle rule is 25 minutes instead of the shared 50.
    const codexIdle = engine === "codex" ? { idleLimit: policy.codexMinTokens, idleMs: policy.codexIdleMs } : {};
    const facts = { engine, tokens: contextTokens, limit, ...codexIdle, status, inCopyMode, quietMs, now: now() };
    const first = pauseCompactDecision(facts, policy);
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
