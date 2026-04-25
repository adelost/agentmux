// Bridge-side poll loop that sends "re-read your CLAUDE.md" reminders to
// panes that have drifted from their rules (attention-weight decay over
// many turns). Mirrors the shape of channels/auto-compact.mjs — pure
// decision lives in core/reminder-state.mjs, this is the I/O layer.
//
// Triggers: turns-since-last-(reminder-or-compact) ≥ threshold AND pane
// is idle. Compact events auto-reset the counter because /compact
// reloads system-context with fresh prominence.

import { listAgents, findChannelForPane } from "../cli/config.mjs";
import { detectPaneStatus } from "../cli/format.mjs";
import { panePathFor, countTurnsSince, findLatestCompactTs } from "../core/jsonl-reader.mjs";
import {
  loadReminderState,
  saveReminderState,
  decideReminderAction,
  cutoffFor,
  formatReminderMessage,
} from "../core/reminder-state.mjs";
import { forwardReplyAsync as genericForwardReplyAsync, isBoilerplateReply } from "../core/reply-forwarder.mjs";

// Re-exported for the existing drift-guard.test.mjs import.
export { isBoilerplateReply };

export function createDriftGuard({
  agent,
  agentsYamlPath,
  discord,
  config,
  log = (msg) => console.log(`drift-guard | ${msg}`),
}) {
  let intervalId = null;
  let state = loadReminderState(config.statePath);

  async function paneStatus(agentConfig, paneIdx) {
    try {
      const content = await agent.capturePane(agentConfig.name, paneIdx, 50);
      return detectPaneStatus(content);
    } catch {
      return "unknown";
    }
  }

  function readTurnsSinceCutoff(paneDir, cutoffMs) {
    // countTurnsSince accepts null (count all, capped at 51) or a Date.
    // For our threshold of ~40 we just care "≥ threshold?" — capped at
    // 51 is fine because 51 > 40 → action=send still fires.
    const d = cutoffMs != null ? new Date(cutoffMs) : null;
    const res = countTurnsSince(paneDir, d);
    return res?.count ?? 0;
  }

  async function sendReminder(agentConfig, paneIdx, paneKey, turnCount) {
    const agentName = agentConfig.name;
    const text = formatReminderMessage(turnCount);
    const reminderSentAt = Date.now();
    try {
      await agent.sendOnly(agentName, text, paneIdx);
      log(`reminded ${paneKey} at ${turnCount} turns past refresh`);
    } catch (err) {
      log(`send failed for ${paneKey}: ${err.message}`);
      return;
    }
    // Mirror to bound Discord channel so the user sees drift-guard activity
    // in the same timeline as briefs and /compact notices. Mirror failure
    // is a transparency degradation, not a correctness issue.
    const channelId = findChannelForPane(agentsYamlPath, agentName, paneIdx);
    if (channelId && discord) {
      try {
        await discord.send(channelId, text);
      } catch (err) {
        log(`mirror failed for ${paneKey}: ${err.message}`);
      }
    }
    // Detached: forward the agent's reply (if any) to the same channel so
    // the user sees not just the reminder but also any organic recap or
    // recommendation the agent emits in response. Reminder text invites
    // a no-op so most reminders forward nothing — that's expected.
    if (config.forwardReply && channelId && discord) {
      forwardReplyAsync(agentConfig, paneIdx, paneKey, channelId, reminderSentAt);
    }
  }

  function forwardReplyAsync(agentConfig, paneIdx, paneKey, channelId, reminderSentAt) {
    genericForwardReplyAsync({
      agent,
      discord,
      agentName: agentConfig.name,
      pane: paneIdx,
      channelId,
      paneDir: panePathFor(agentConfig, paneIdx),
      sentAtMs: reminderSentAt,
      matcher: (userPrompt) => userPrompt.includes("[drift-guard]"),
      timeoutMs: config.replyTimeoutMs,
      log,
      label: "drift-guard",
    });
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
    let stateChanged = false;

    for (const a of agents) {
      const panes = Array.isArray(a.panes) ? a.panes : [];
      for (let i = 0; i < panes.length; i++) {
        // Only Claude panes have CLAUDE.md baseline rules; skip shells/make/etc.
        // Claude panes are named `claude`, `claude-2`, `claude-3`... in config,
        // but all share `cmd` starting with "claude". Use cmd for robustness.
        if (!String(panes[i]?.cmd || "").startsWith("claude")) continue;

        const paneKey = `${a.name}:${i}`;
        if (!state[paneKey]) state[paneKey] = { lastReminderTsMs: null, lastCompactTsMs: null };
        const paneState = state[paneKey];

        const paneDir = panePathFor(a, i);

        // Step 1: detect new /compact. If so, advance lastCompactTsMs AND
        // skip reminder this tick — the pane just refreshed its rules.
        const latestCompactTs = findLatestCompactTs(paneDir);
        if (latestCompactTs != null &&
            (paneState.lastCompactTsMs == null || latestCompactTs > paneState.lastCompactTsMs)) {
          paneState.lastCompactTsMs = latestCompactTs;
          stateChanged = true;
          log(`reset ${paneKey} on /compact at ${new Date(latestCompactTs).toISOString()}`);
          continue;
        }

        // Step 2: compute effective cutoff (later of reminder/compact).
        const cutoffMs = cutoffFor(paneState);
        const turnsSinceCutoff = readTurnsSinceCutoff(paneDir, cutoffMs);

        // Step 3: check pane status so we don't interrupt active work.
        const status = await paneStatus(a, i);

        const decision = decideReminderAction({
          turnsSinceCutoff,
          status,
          turnThreshold: config.turnThreshold,
        });

        if (decision.action === "send") {
          await sendReminder(a, i, paneKey, turnsSinceCutoff);
          paneState.lastReminderTsMs = now;
          stateChanged = true;
        }
      }
    }

    if (stateChanged) {
      try { saveReminderState(state, config.statePath); }
      catch (err) { log(`state save failed: ${err.message}`); }
    }
  }

  function start() {
    if (!config.enabled) {
      log(`disabled (AMUX_REMIND_ENABLED=false)`);
      return;
    }
    if (intervalId) return;
    log(`enabled | threshold=${config.turnThreshold} turns poll=${Math.round(config.pollMs / 1000)}s`);
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

  // Reload state from disk — useful if `amux remind` (CLI) modifies state
  // between ticks.
  function reloadState() {
    state = loadReminderState(config.statePath);
  }

  return { start, stop, tick, reloadState };
}
