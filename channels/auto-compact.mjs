// Bridge-side poll loop that drives decideAutoCompactAction for every
// configured pane, fires Discord warnings, and sends /compact when the
// grace window elapses. Keeps just enough state (warnings + in-flight
// compact lock) to avoid double-firing. Pure decision logic lives in
// core/auto-compact.mjs; this file is the I/O integration layer.

import {
  decideAutoCompactAction,
  formatWarningMessage,
  formatCompactedMessage,
} from "../core/auto-compact.mjs";
import { listAgents, findChannelForPane } from "../cli/config.mjs";
import { getContextFromPane } from "../core/context.mjs";
import { detectPaneStatus } from "../cli/format.mjs";
import { readLastTurns, panePathFor } from "../core/jsonl-reader.mjs";

// Panes that have warnings pending (paneKey → { warned_at: ms }).
// Panes currently mid-compact (paneKey string).
// Both maps are in-memory — warnings are cheap to re-derive after a
// bridge restart (next poll re-warns if still over threshold).

export function createAutoCompact({
  agent,
  agentsYamlPath,
  discord,
  tmux,      // tmux exec function, same signature as createTmuxContext provides
  config,
  log = (msg) => console.log(`auto-compact | ${msg}`),
}) {
  const warnings = new Map();
  const compacting = new Set();
  let intervalId = null;

  async function inspect(agentConfig, paneIdx) {
    // Mirrors cli/commands.mjs inspectPane just enough for our decision.
    // Wrapped in try/catch because any pane quirk (just-spawned, dead
    // session) should degrade to "no data" rather than crash the poller.
    let status = "unknown";
    let content = "";
    let paneInMode = "0";
    let lastActivityMs = null;

    try {
      content = await agent.capturePane(agentConfig.name, paneIdx, 100);
    } catch {}

    try {
      status = detectPaneStatus(content);
    } catch {
      status = "unknown";
    }

    try {
      const { stdout } = await tmux(`display-message -t '${agentConfig.name}:.${paneIdx}' -p '#{pane_in_mode}'`);
      paneInMode = (stdout || "").trim() || "0";
    } catch {}

    const ctxInfo = getContextFromPane(content, agentConfig.dir || "");
    const contextPercent = ctxInfo?.percent ?? null;

    // Last conversation turn timestamp from jsonl. Used by min-idle gate
    // to distinguish "idle prompt char visible" from "conversation truly
    // stalled". Missing jsonl (just-spawned pane, /clear, etc) → null,
    // which lets the gate fall through.
    try {
      const paneDir = panePathFor(agentConfig, paneIdx);
      const turns = readLastTurns(paneDir, 1);
      if (turns.length && turns[0].timestamp) {
        const t = Date.parse(turns[0].timestamp);
        if (Number.isFinite(t)) lastActivityMs = t;
      }
    } catch {}

    return { status, contextPercent, paneInMode, lastActivityMs };
  }

  async function fireCompact(agentName, paneIdx, paneKey, contextPercent) {
    if (compacting.has(paneKey)) return;
    compacting.add(paneKey);
    try {
      await agent.sendOnly(agentName, "/compact", paneIdx);
      log(`fired /compact on ${paneKey} (was ${contextPercent}%)`);

      const channelId = findChannelForPane(agentsYamlPath, agentName, paneIdx);
      if (channelId && discord) {
        try {
          await discord.send(channelId, formatCompactedMessage(paneKey, contextPercent));
        } catch (err) {
          log(`compacted-notice send failed for ${paneKey}: ${err.message}`);
        }
      }
    } catch (err) {
      log(`fire failed for ${paneKey}: ${err.message}`);
    } finally {
      // Release lock after ~2 min. /compact takes 30-90s; we want to
      // prevent a follow-up poll from re-firing while the pane still
      // shows old context% pre-summary.
      setTimeout(() => compacting.delete(paneKey), 120_000);
    }
  }

  async function postWarning(agentName, paneIdx, paneKey, contextPercent) {
    const channelId = findChannelForPane(agentsYamlPath, agentName, paneIdx);
    if (!channelId || !discord) {
      log(`no discord channel for ${paneKey}, warning suppressed (will still fire at grace end)`);
      return;
    }
    try {
      await discord.send(channelId, formatWarningMessage(paneKey, contextPercent, config.graceMs));
      log(`warned ${paneKey} at ${contextPercent}%`);
    } catch (err) {
      log(`warning send failed for ${paneKey}: ${err.message}`);
    }
  }

  async function tick() {
    if (!config.enabled) return;

    let agents;
    try {
      agents = listAgents(agentsYamlPath);
    } catch {
      return;
    }

    const now = Date.now();

    for (const a of agents) {
      const panes = Array.isArray(a.panes) ? a.panes : [];
      for (let i = 0; i < panes.length; i++) {
        const paneKey = `${a.name}:${i}`;
        if (compacting.has(paneKey)) continue;

        const { status, contextPercent, paneInMode, lastActivityMs } = await inspect(a, i);
        const decision = decideAutoCompactAction({
          paneKey,
          status,
          contextPercent,
          paneInMode,
          lastActivityMs,
          warnings,
          config,
          now,
        });

        if (decision.action === "warn") {
          warnings.set(paneKey, { warned_at: now });
          await postWarning(a.name, i, paneKey, contextPercent);
        } else if (decision.action === "compact") {
          warnings.delete(paneKey);
          await fireCompact(a.name, i, paneKey, contextPercent);
        } else if (decision.action === "cancel") {
          warnings.delete(paneKey);
          log(`cancelled warning for ${paneKey} (${decision.reason})`);
        }
        // action === "none" → do nothing
      }
    }
  }

  function start() {
    if (!config.enabled) {
      log(`disabled (AUTO_COMPACT_ENABLED=false)`);
      return;
    }
    if (intervalId) return;
    log(`enabled | threshold=${config.threshold}% grace=${Math.round(config.graceMs / 1000)}s poll=${Math.round(config.pollMs / 1000)}s min-idle=${Math.round(config.minIdleMs / 1000)}s`);
    intervalId = setInterval(() => {
      tick().catch((err) => log(`tick failed: ${err.message}`));
    }, config.pollMs);
  }

  function stop() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  // Expose internals for tests + introspection (amux done warnings column)
  function getWarnings() {
    const out = {};
    for (const [k, v] of warnings) out[k] = v;
    return out;
  }

  return { start, stop, tick, getWarnings };
}
