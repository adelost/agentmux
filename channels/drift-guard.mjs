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
import { panePathFor, countTurnsSince, findLatestCompactTs, readLastTurns } from "../core/jsonl-reader.mjs";
import {
  loadReminderState,
  saveReminderState,
  decideReminderAction,
  cutoffFor,
  formatReminderMessage,
} from "../core/reminder-state.mjs";

// Replies that don't carry signal worth mirroring. Match case-insensitively
// against the reply text trimmed. If everything in the reply is boilerplate,
// skip the forward — the channel already shows the reminder, repeating
// "Acknowledged." adds noise. Real recommendations or context-dependent
// answers go through.
const BOILERPLATE_PATTERNS = [
  /^no response requested\.?$/i,
  /^acknowledged\.?$/i,
  /^re-?l(ä|a)st\.?$/i,
  /^l(ä|a)st\.?\s*standby\.?$/i,
  /^standby\.?$/i,
  /^(ok|okej|ok\.?|okay)\.?$/i,
];

export function isBoilerplateReply(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return true;
  return BOILERPLATE_PATTERNS.some((re) => re.test(trimmed));
}

/** Extract assistant text reply to the most recent reminder turn after sinceMs. */
function extractAssistantReply(paneDir, sinceMs, reminderMarker = "[drift-guard]") {
  // Look back a small slack window so we definitely catch the reminder turn
  // (jsonl write may lag slightly behind sendOnly's timestamp).
  const since = new Date(sinceMs - 2000);
  const result = readLastTurns(paneDir, { since, limit: 5 });
  if (!result || !result.turns.length) return null;
  // Find the most recent turn whose userPrompt is the reminder we sent.
  // (Channels are per-pane so any [drift-guard] turn after sinceMs is ours.)
  const reminderTurn = [...result.turns].reverse().find(
    (t) => t.userPrompt && t.userPrompt.includes(reminderMarker),
  );
  if (!reminderTurn) return null;
  const textItems = reminderTurn.items.filter((it) => it.type === "text");
  if (!textItems.length) return null;
  return textItems.map((it) => it.content).join("\n\n").trim();
}

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
    (async () => {
      const paneDir = panePathFor(agentConfig, paneIdx);
      const deadline = reminderSentAt + config.replyTimeoutMs;
      // Poll until pane idle or timeout. Keep polls cheap (2s) — we only
      // care about the turn boundary, not real-time updates.
      while (Date.now() < deadline) {
        await sleep(2000);
        let busy = true;
        try { busy = await agent.isBusy(agentConfig.name, paneIdx); }
        catch { /* treat as busy, retry */ }
        if (!busy) break;
      }
      const reply = extractAssistantReply(paneDir, reminderSentAt);
      if (!reply) {
        log(`${paneKey}: no reply to forward (silent re-read or timeout)`);
        return;
      }
      if (isBoilerplateReply(reply)) {
        log(`${paneKey}: boilerplate reply skipped (${reply.slice(0, 40).replace(/\n/g, " ")})`);
        return;
      }
      // Discord caps at 2000 chars per message. Single-message safety;
      // tighter than the 2k limit to leave room for rendering quirks.
      const safe = reply.length > 1900 ? reply.slice(0, 1900) + "\n…[truncated]" : reply;
      try {
        await discord.send(channelId, safe);
        log(`${paneKey}: forwarded reply (${reply.length}b)`);
      } catch (err) {
        log(`${paneKey}: forward send failed: ${err.message}`);
      }
    })().catch((err) => log(`${paneKey}: forwarder crashed: ${err.message}`));
  }

  function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
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
