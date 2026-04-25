// Output formatting for agent CLI. Status icons, tables, truncation.

import { stripAnsi } from "../lib.mjs";
import { ALL_DIALECTS } from "../core/dialects.mjs";

/** Detect pane status from captured content. */
export function detectPaneStatus(paneContent) {
  const text = stripAnsi(paneContent);
  // "esc to interrupt" is the historical marker but Claude Code also
  // renders thinking spinners (✻/✽/✢/✶/✺/◐) followed by a verb + duration
  // ("Cogitated for 46s", "Sautéed for 1m 48s", "Undulating…") and tool-call
  // status lines ("Running… (6m 25s · timeout 10m)" + "ctrl+b ctrl+b" hint).
  // Any of these indicates the agent is generating — without them we fall
  // through to the prompt-line check and false-positive into idle.
  if (/esc to interrupt/.test(text)) return "working";
  // Spinner glyph + verb-word + ("for X" | ellipsis "…"). Catches:
  //   "✻ Sautéed for 1m 48s", "✻ Cogitated for 46s", "✢ Undulating…"
  //   "✶ Crystallizing… (7s · thinking)", "✻ Crunched for 55s"
  // Requires a "for" or "…" immediately after the verb so a stray spinner
  // glyph in user prose ("✻ is a fancy char") doesn't false-positive.
  if (/[✻✽✢✶✺◐◑◒◓]\s+\S+(?:\s+for\b|…)/.test(text)) return "working";
  if (/Running…[\s\S]*ctrl\+b ctrl\+b/.test(text)) return "working";
  if (/Allow once|Allow always|Do you want to proceed/.test(text)) return "permission";
  if (/Enter to select|Esc to cancel/.test(text)) return "menu";
  if (/Resume from summary/.test(text)) return "resume";
  if (/0: Dismiss/.test(text)) return "dismiss";
  // Search last 10 lines for any dialect's prompt marker
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const tail = lines.slice(-10);
  const hasPrompt = tail.findLast((l) => ALL_DIALECTS.some((d) => l.startsWith(d.promptChar)));
  if (hasPrompt) return "idle";
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

/** Abbreviate a token count: 134800 → "134.8k", 1200000 → "1.2M". */
export function formatTokens(n) {
  if (n == null) return "";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

/** Format "{percent}% {tokens}" into a fixed-width column for agent ps.
 *  ctx is { percent, tokens } from getContextFromPane, or null. */
export function formatContextCell(ctx) {
  if (!ctx) return "          "; // 10 spaces, preserves column alignment
  const pct = `${ctx.percent}%`;
  const tok = formatTokens(ctx.tokens);
  return `${pct.padStart(4)} ${tok.padEnd(5)}`;
}
