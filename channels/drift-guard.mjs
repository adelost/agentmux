// Bridge-side poll loop that sends "re-read your agent instructions" reminders to
// panes that have drifted from their rules (attention-weight decay over
// many turns). Mirrors the shape of channels/auto-compact.mjs — pure
// decision lives in core/reminder-state.mjs, this is the I/O layer.
//
// Triggers: turns-since-last-(reminder-or-compact) ≥ threshold AND pane
// is idle. Compact events auto-reset the counter because /compact
// reloads system-context with fresh prominence.

import { listAgents, findChannelForPane } from "../cli/config.mjs";
import { detectPaneStatus } from "../cli/format.mjs";
import { panePathFor } from "../core/jsonl-reader.mjs";
import { readReminderActivity } from "../core/reminder-activity.mjs";
import { dialectFor } from "../cli/inspect-pane.mjs";
import { isCodingDialect } from "../core/dialects.mjs";
import { latestPaneStatesCached, mergeStatus } from "../core/events.mjs";
import { TERMINAL_DELIVERY_STATES } from "../core/delivery-queue-policy.mjs";
import {
  loadReminderState,
  saveReminderState,
  decideReminderAction,
  cutoffFor,
  formatReminderMessage,
  recordReminderDelivery,
} from "../core/reminder-state.mjs";
import { readParkState } from "../core/pane-park.mjs";

/** WHAT: Schedules the bridge's idle-pane reminder checks. WHY: Keeps delivery receipts separate from activity and scheduling decisions. */
export function createDriftGuard({
  agent,
  deliveryBroker = null,
  agentsYamlPath,
  discord,
  config,
  log = (msg) => console.log(`drift-guard | ${msg}`),
}) {
  let intervalId = null;
  let ticking = false;
  let state = loadReminderState(config.statePath);

  async function paneStatus(agentConfig, paneIdx) {
    try {
      const content = await agent.capturePane(agentConfig.name, paneIdx, 50);
      return content ? mergeStatus(detectPaneStatus(content), latestPaneStatesCached().get(`${agentConfig.name}:${paneIdx}`)).status : "unknown";
    } catch {
      return "unknown";
    }
  }

  async function sendReminder(agentConfig, paneIdx, paneKey, turnCount, reminderCount, dialect, latestWork) {
    const agentName = agentConfig.name;
    const text = formatReminderMessage(turnCount, reminderCount, dialect, agentConfig.dir);
    const rotationKey = `drift-guard:${paneKey}:${reminderCount}`;
    const idempotencyKey = `${rotationKey}:${Date.parse(latestWork)}`;
    try {
      // No sendOnly fallback: it can wake a stopped CLI and lacks a receipt.
      if (!deliveryBroker?.queue?.list) return false;
      const jobs = deliveryBroker.queue.list(agentName, paneIdx);
      const rotation = jobs.filter((job) => job.idempotencyKey === rotationKey || job.idempotencyKey?.startsWith(`${rotationKey}:`));
      if (rotation.some((job) => job.status === "acknowledged")) return true;
      // A terminal non-receipt may retry only after new real work, not each tick.
      if (rotation.some((job) => job.idempotencyKey === idempotencyKey)) return false;
      if (jobs.some((job) => job.source === "drift-guard" && !TERMINAL_DELIVERY_STATES.has(job.status))) return false;
      const result = await deliveryBroker.enqueueAndWait({ agentName, pane: paneIdx, text, source: "drift-guard", idempotencyKey });
      log(`${result.delivered ? "reminded" : "unacknowledged reminder for"} ${paneKey} at ${turnCount} turns past refresh`);
      if (result.delivered !== true) return false;
    } catch (err) {
      log(`send failed for ${paneKey}: ${err.message}`);
      return false;
    }
    // Mirror the reminder text to the bound Discord channel so the user
    // sees drift-guard activity in the timeline. Failure is a transparency
    // degradation, not a correctness issue.
    //
    // Forwarding the agent's reply is the jsonl-watcher's job now —
    // forwardReplyAsync used to live here with a "[drift-guard]" matcher
    // and 60s timeout, but it lost replies whenever the agent took
    // longer than the timeout. The watcher catches every turn regardless.
    const channelId = findChannelForPane(agentsYamlPath, agentName, paneIdx);
    if (channelId && discord) {
      try {
        await discord.send(channelId, text);
      } catch (err) {
        log(`mirror failed for ${paneKey}: ${err.message}`);
      }
    }
    return true;
  }

  async function tickOnce() {
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
      if (a.backend === "native") continue;
      const panes = Array.isArray(a.panes) ? a.panes : [];
      for (let i = 0; i < panes.length; i++) {
        const dialect = dialectFor(a, { index: i });
        if (!isCodingDialect(dialect)) continue;

        const paneKey = `${a.name}:${i}`;
        if (!state[paneKey]) state[paneKey] = { lastReminderTsMs: null, lastCompactTsMs: null };
        const paneState = state[paneKey];

        const status = await paneStatus(a, i);
        const runtimeState = typeof agent.paneProcessState === "function"
          ? await agent.paneProcessState(a.name, i).catch(() => null) : null;
        if (status !== "idle" || !runtimeState?.running || runtimeState.dead || runtimeState.shell) continue;

        const paneDir = panePathFor(a, i);

        // Step 1: detect new /compact. If so, advance lastCompactTsMs AND
        // skip reminder this tick — the pane just refreshed its rules.
        const turnActivity = readReminderActivity(paneDir, panes[i].cmd, cutoffFor(paneState));
        const latestCompactTs = turnActivity.latestCompactTs;
        if (latestCompactTs != null &&
            (paneState.lastCompactTsMs == null || latestCompactTs > paneState.lastCompactTsMs)) {
          paneState.lastCompactTsMs = latestCompactTs;
          stateChanged = true;
          log(`reset ${paneKey} on /compact at ${new Date(latestCompactTs).toISOString()}`);
          continue;
        }

        const decision = decideReminderAction({
          turnsSinceCutoff: turnActivity.count,
          status,
          turnThreshold: config.turnThreshold,
          latestWorkTsMs: Date.parse(turnActivity.latest || ""),
          nowMs: now,
          activeWindowMs: config.activeWindowMs,
          runtimeState,
        });

        if (decision.action === "send") {
          // Parked panes (model downgrade) are never woken — even the
          // one-sentence summary reply would run on the fallback model.
          if (readParkState(a.name, i)) {
            log(`skip ${paneKey}: parked (model downgrade)`);
            continue;
          }
          // reminderCount picks the DRIFT_SECTIONS rotation slot; legacy
          // state entries without it start at 0 (highest-priority rule).
          const reminderCount = paneState.reminderCount || 0;
          const sent = await sendReminder(a, i, paneKey, turnActivity.count, reminderCount, dialect, turnActivity.latest);
          if (recordReminderDelivery(paneState, { delivered: sent, nowMs: now, reminderCount })) {
            stateChanged = true;
          }
        }
      }
    }

    if (stateChanged) {
      try { saveReminderState(state, config.statePath); }
      catch (err) { log(`state save failed: ${err.message}`); }
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try { await tickOnce(); }
    finally { ticking = false; }
  }

  function start() {
    if (!config.enabled) {
      log(`disabled (AMUX_REMIND_ENABLED=false)`);
      return;
    }
    if (intervalId) return;
    log(`enabled | threshold=${config.turnThreshold} turns active=${Math.round(config.activeWindowMs / 60000)}m poll=${Math.round(config.pollMs / 1000)}s`);
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
