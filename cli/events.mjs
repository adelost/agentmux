// Event logging for agent CLI. Writes to log file + optional notifications.

import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";

const DEFAULT_LOG = "/tmp/agent-events.log";

/** Classify event for formatting. */
export function eventCategory(event) {
  if (/DONE|COMPLETE|READY/.test(event)) return "done";
  if (/STUCK|TIMEOUT|MENU|PERMISSION|ERROR|CRASH/.test(event)) return "problem";
  return "compact";
}

/** Build actionable hints for problem events. */
export function buildActions(name, pane, event) {
  const actions = [];
  if (/MENU/.test(event)) actions.push(`agent select ${name} <N> -p ${pane}`);
  if (/PERMISSION/.test(event)) actions.push(`agent select ${name} 1 -p ${pane} (Allow once)`);
  if (/STUCK/.test(event)) actions.push(`agent esc ${name} -p ${pane}`, `agent log ${name} -p ${pane}`);
  if (/TIMEOUT/.test(event)) actions.push(`agent log ${name} -p ${pane} --full`);
  return actions;
}

/** Create event logger. */
export function createEventLogger({ logFile = DEFAULT_LOG, notify = null } = {}) {
  mkdirSync(dirname(logFile), { recursive: true });

  /**
   * Log an agent event.
   * @param {string} icon - emoji icon
   * @param {string} name - agent name
   * @param {number} pane - pane index
   * @param {string} event - event type (DONE, STUCK, etc)
   * @param {string} detail - human-readable detail
   * @param {string} [output] - optional output to include in full format
   */
  function agentEvent(icon, name, pane, event, detail, output) {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    const cat = eventCategory(event);

    // Compact log line
    const logLine = `[${ts}] ${icon} ${name}:${pane} ${event} ${detail}`;
    appendFileSync(logFile, logLine + "\n");

    // Full notification for done/problem events
    if (cat !== "compact" && notify) {
      const lines = [`${icon} **${name}** (pane ${pane}): ${event}`, detail];
      const actions = buildActions(name, pane, event);
      if (actions.length) lines.push("", "**Actions:**", ...actions.map((a) => `\`${a}\``));
      if (output) lines.push("", "```", output.slice(0, 500), "```");
      notify(lines.join("\n")).catch(() => {});
    }
  }

  return agentEvent;
}

/** Show event log (tail). */
export function showEvents(logFile = DEFAULT_LOG, lines = 30, follow = false) {
  try {
    const content = readFileSync(logFile, "utf-8");
    const all = content.trim().split("\n");
    return all.slice(-lines).join("\n");
  } catch {
    return "No events yet.";
  }
}
