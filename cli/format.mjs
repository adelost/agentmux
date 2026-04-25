// Output formatting for agent CLI. Status icons, tables, truncation.

import { stripAnsi } from "../lib.mjs";
import { ALL_DIALECTS } from "../core/dialects.mjs";

/** Detect pane status from captured content. */
export function detectPaneStatus(paneContent) {
  const text = stripAnsi(paneContent);
  // Tail-only scan for liveness markers. Old spinners from completed turns
  // linger in scrollback indefinitely, so a full-text match would false-
  // positive into "working" long after the agent finished. The active
  // spinner / Running… line is always rendered above the prompt within
  // the visible region — the last ~15 raw lines covers it across both
  // 200-line and 50-line capture sizes used by ps and the bridge.
  const rawLines = text.split("\n");
  const tailRaw = rawLines.slice(-15).join("\n");

  // "esc to interrupt" is Claude's historical inline interrupt hint.
  // Newer streams render thinking spinners (✻/✽/✢/✶/✺/◐) followed by a
  // verb + duration ("Cogitated for 46s", "Sautéed for 1m 48s",
  // "Undulating…") and tool-call status lines ("Running… (6m 25s ·
  // timeout 10m)" + "ctrl+b ctrl+b" background-hint). Any of these in
  // the tail indicates the agent is generating right now.
  if (/esc to interrupt/.test(tailRaw)) return "working";
  // Spinner glyph + verb-word + ("for X" | ellipsis "…"). The "for" or "…"
  // suffix prevents a stray spinner glyph in user prose from triggering.
  if (/[✻✽✢✶✺◐◑◒◓]\s+\S+(?:\s+for\b|…)/.test(tailRaw)) return "working";
  if (/Running…[\s\S]*ctrl\+b ctrl\+b/.test(tailRaw)) return "working";

  // Modal / prompt states: full-text is fine because these don't linger
  // in scrollback after dismissal — when "Allow once" is gone, it's gone.
  if (/Allow once|Allow always|Do you want to proceed/.test(text)) return "permission";
  if (/Enter to select|Esc to cancel/.test(text)) return "menu";
  if (/Resume from summary/.test(text)) return "resume";
  if (/0: Dismiss/.test(text)) return "dismiss";

  // Search last 10 trimmed lines for any dialect's prompt marker
  const lines = rawLines.map((l) => l.trim()).filter(Boolean);
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
