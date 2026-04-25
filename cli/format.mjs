// Output formatting for agent CLI. Status icons, tables, truncation.

import { stripAnsi } from "../lib.mjs";
import { ALL_DIALECTS } from "../core/dialects.mjs";

/** Detect pane status from captured content. */
export function detectPaneStatus(paneContent) {
  const text = stripAnsi(paneContent);
  // "esc to interrupt" is the only RELIABLE single-capture signal that
  // Claude is actively streaming. Spinner-lines like "✻ Sautéed for X"
  // and "✢ Undulating…" have the same shape whether the timer is still
  // counting up (active) or frozen post-turn (residue) — distinguishing
  // requires either two captures or jsonl-mtime cross-check, both done
  // outside this pure function. Callers that want a stronger "working"
  // signal should layer jsonl-mtime on top (see cmdPs / amux done's
  // isRunningNow overlay).
  if (/esc to interrupt/.test(text)) return "working";

  // Prompt-first ordering: a live modal (Allow once / 0: Dismiss / Enter to
  // select / Resume from summary) REPLACES the input box, so the `❯` prompt
  // disappears while the modal is showing. If we still see the prompt at tail,
  // the pane is not in a modal state — any matching keyword is just *content*
  // (e.g. an agent diagnosing a dismiss-bug literally writes "0: Dismiss" into
  // its turn output). Without this anchor, substring-match over the full pane
  // gives false 🟡/🔴 on every pane discussing these strings.
  const lines = text.split("\n");
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  const tail = nonEmpty.slice(-10);
  const hasPrompt = tail.findLast((l) => ALL_DIALECTS.some((d) => l.startsWith(d.promptChar)));
  if (hasPrompt) return "idle";

  // No prompt → real modal possible. Match on tail-15 to keep "Allow once"
  // boxes (which can span 5-10 lines) detectable.
  const tailText = lines.slice(-15).join("\n");
  if (/Allow once|Allow always|Do you want to proceed/.test(tailText)) return "permission";
  if (/Enter to select|Esc to cancel/.test(tailText)) return "menu";
  if (/Resume from summary/.test(tailText)) return "resume";
  if (/0: Dismiss/.test(tailText)) return "dismiss";

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
