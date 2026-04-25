// Output formatting for agent CLI. Status icons, tables, truncation.

import { stripAnsi } from "../lib.mjs";
import { ALL_DIALECTS } from "../core/dialects.mjs";

/** Detect pane status from captured content. */
export function detectPaneStatus(paneContent) {
  const text = stripAnsi(paneContent);
  const lines = text.split("\n");
  const tailRaw = lines.slice(-15).join("\n");

  // Working signals — match any of them in the LAST 15 lines so we don't
  // false-positive on scrollback residue from completed turns.
  //
  // 1. "esc to interrupt" — Claude's classic inline interrupt hint
  // 2. Token-stream footer "↓ X.Yk tokens" or "↑ X.Yk tokens"
  //    → "(2m 30s · ↓ 7.2k tokens)" only appears during live streaming;
  //    the count + arrow disappears the moment the turn settles.
  //
  // Generic spinner glyphs ("✻ Sautéed for X", "✢ Undulating…") are
  // intentionally NOT matched here — they linger in scrollback after the
  // turn ends and look identical when frozen. The jsonl-mtime overlay in
  // inspectPane (cmdPs) handles those by cross-checking actual file
  // activity within the last 30s.
  if (/esc to interrupt/.test(tailRaw)) return "working";
  if (/[↓↑]\s*\d+(?:\.\d+)?[kKmM]?\s*tokens/.test(tailRaw)) return "working";

  // Prompt-first ordering: a live modal (Allow once / 0: Dismiss / Enter to
  // select / Resume from summary) REPLACES the input box, so the `❯` prompt
  // disappears while the modal is showing. If we still see the prompt at tail,
  // the pane is not in a modal state — any matching keyword is just *content*
  // (e.g. an agent diagnosing a dismiss-bug literally writes "0: Dismiss" into
  // its turn output). Without this anchor, substring-match gives false 🟡/🔴
  // on every pane discussing these strings.
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  const tail = nonEmpty.slice(-10);
  const hasPrompt = tail.findLast((l) => ALL_DIALECTS.some((d) => l.startsWith(d.promptChar)));
  if (hasPrompt) return "idle";

  // No prompt → real modal possible. Tail-15 keeps "Allow once" boxes
  // (5-10 lines) detectable.
  if (/Allow once|Allow always|Do you want to proceed/.test(tailRaw)) return "permission";
  if (/Enter to select|Esc to cancel/.test(tailRaw)) return "menu";
  if (/Resume from summary/.test(tailRaw)) return "resume";
  if (/0: Dismiss/.test(tailRaw)) return "dismiss";

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
