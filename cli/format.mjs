// Output formatting for agent CLI. Status icons, tables, truncation.

import { stripAnsi } from "../lib.mjs";

/** Detect pane status from captured content. */
export function detectPaneStatus(paneContent) {
  const text = stripAnsi(paneContent);
  if (/esc to interrupt/.test(text)) return "working";
  if (/Allow once|Allow always|Do you want to proceed/.test(text)) return "permission";
  if (/Enter to select|Esc to cancel/.test(text)) return "menu";
  if (/Resume from summary/.test(text)) return "resume";
  if (/0: Dismiss/.test(text)) return "dismiss";
  // Search last 10 lines for idle prompt
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const tail = lines.slice(-10);
  if (tail.findLast((l) => l.startsWith("❯"))) return "idle";
  return "unknown";
}

/** Status icon for a pane state. */
export function statusIcon(status) {
  const icons = {
    working: "🟢",
    permission: "🔴",
    menu: "🔴",
    resume: "🟡",
    dismiss: "🟡",
    idle: "💤",
    unknown: "⚪",
  };
  return icons[status] || "⚪";
}

/** Format a row for agent ls. */
export function formatAgentRow(index, name, dir, running, paneCount) {
  const status = running ? "●" : "○";
  const panes = paneCount > 1 ? ` (${paneCount} panes)` : "";
  return `${String(index).padStart(2)}   ${name.padEnd(12)} ${dir.padEnd(50)} ${status}${panes}`;
}

/** Truncate string with ellipsis. */
export function truncate(str, max = 80) {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}
