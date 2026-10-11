// Bridge side of compaction at a natural pause. Gathers the session evidence a
// pane needs only once it is over budget at a pause, asks the pure decision,
// and either logs what would happen (dry) or compacts through context
// maintenance (on). Every outcome is written once per pause to a JSONL log.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PAUSE_COMPACT_POLICY, readContextCostPolicy } from "../policies/context-cost.mjs";
import { latestPaneSessionIdentity } from "../core/native-session-identity.mjs";
import { lastContextCompactAt } from "../core/context-maintenance.mjs";
import { codexBackgroundActivity, latestJournalCompactMs, leaderPanes, pauseCompactDecision, pauseCompactLimit,
  sessionBackgroundActivity } from "../core/pause-compact.mjs";

const BACKGROUND_BY_ENGINE = Object.freeze({ claude: sessionBackgroundActivity, codex: codexBackgroundActivity });

export const PAUSE_COMPACT_LOG = join(homedir(), ".agentmux", "pause-compact.jsonl");

const appendJsonLine = (path, record) => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
};

/** WHAT: Builds the pause-compaction step of the auto-compact poll. WHY: Keeps the new rule beside the 50-minute rule without changing it. */
export function createPauseCompact({ contextMaintenance, state, modes, policy = PAUSE_COMPACT_POLICY, idleTokens = readContextCostPolicy().maxTokens, now = Date.now,
  log = () => {}, record = (line) => appendJsonLine(PAUSE_COMPACT_LOG, line),
  identityFor = latestPaneSessionIdentity, backgroundFor = BACKGROUND_BY_ENGINE, journalCompactFor = latestJournalCompactMs }) {
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
  async function consider({ agentConfig, pane, engine, paneDir, status, inCopyMode, contextTokens, lastActivityMs }) {
    const mode = modes[engine] || "off";
    if (mode === "off") return false;
    const name = agentConfig.name;
    const paneKey = `${name}:${pane}`;
    const limit = pauseCompactLimit(agentConfig, pane, policy);
    const quietMs = Number.isFinite(lastActivityMs) ? now() - lastActivityMs : NaN;
    // Codex's cache lives about 30 minutes, so its idle rule is 25 minutes instead of the shared 50.
    const codexIdle = engine === "codex" ? { idleLimit: idleTokens, idleMs: policy.codexIdleMs } : {};
    const facts = { engine, tokens: contextTokens, limit, ...codexIdle, status, inCopyMode, quietMs, now: now() };
    if (pauseCompactDecision(facts, policy).action === "none") return false;

    const identity = identityFor(engine, paneDir);
    if (!identity?.path) return false;
    const decision = pauseCompactDecision({ ...facts,
      background: backgroundFor[engine]({ sessionPath: identity.path, sessionId: identity.sessionId, paneDir, now: facts.now, policy }),
      lastCompactAt: lastCompactAt(name, pane, paneKey, identity.path) }, policy);
    const line = { at: new Date(facts.now).toISOString(), pane: paneKey, mode, tokens: contextTokens, limit: decision.budget ?? limit,
      leader: leaderPanes(agentConfig).has(pane), quietSec: Math.round(quietMs / 1000), cell: decision.cell, detail: decision.detail };
    if (decision.action === "hold") {
      report(paneKey, lastActivityMs, { ...line, outcome: "held" });
      return false;
    }

    // The same admission as a live compact: lease, fence, delivery in flight, session, busy screen, composer.
    const result = await contextMaintenance.run(name, pane, { pauseTokens: decision.budget, dry: mode === "dry" });
    if (result.dry) {
      dryCompacts.set(paneKey, facts.now);
      report(paneKey, lastActivityMs, { ...line, outcome: "would-compact", tokens: result.tokens ?? contextTokens });
      return false;
    }
    const outcome = result.compacted ? "compacted" : result.attempted ? "failed" : result.ok ? "skipped" : "refused";
    report(paneKey, lastActivityMs, { ...line, outcome, cell: result.cell || line.cell, detail: result.reason || line.detail });
    return Boolean(result.compacted || result.attempted);
  }

  return { consider };
}
