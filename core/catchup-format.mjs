// Format preview lines for the Discord catch-up notice.
//
// Input: turns as produced by readLastTurns() — each { timestamp, userPrompt,
// items } where items = [{ type: "text"|"tool", content: string }].
//
// Output: up to 3 preview lines, one per turn, showing the most-recent
// readable content per turn:
//   • HH:MM you: <user prompt preview>
//   • HH:MM claw: <assistant text preview>
//
// Rules:
//   - Turn with assistant text  → show assistant side (that's the news)
//   - Turn with only tool calls → skip entirely (user won't care about
//                                  intermediate tool chatter)
//   - Turn pending (no items)   → show user side (their msg is in flight)
//   - Code fences collapsed to [code]
//   - Multi-line → first line + "…"
//   - Long text trimmed to ~80 chars + "…"

const MAX_PREVIEW_LINES = 3;
const MAX_PREVIEW_CHARS = 80;

/**
 * Build the preview lines that go under the count row of the catch-up notice.
 *
 * @param {Array<object>} turns - from readLastTurns(), chronological order
 * @param {object} [opts]
 * @param {string} [opts.agentName="claw"] - prefix for assistant-side lines
 * @returns {string[]} zero or more preview strings; caller joins with "\n"
 */
export function formatCatchupPreview(turns, opts = {}) {
  const agentName = opts.agentName || "claw";
  const rows = [];
  for (const t of turns) {
    const row = extractPreviewRow(t);
    if (row) rows.push(row);
  }
  const recent = rows.slice(-MAX_PREVIEW_LINES);
  return recent.map((r) => renderPreviewLine(r, agentName));
}

/** Decide which single row (if any) represents a turn in the preview. */
function extractPreviewRow(turn) {
  const items = turn.items || [];
  const textItems = items.filter((i) => i.type === "text");

  if (textItems.length > 0) {
    return {
      timestamp: turn.timestamp,
      role: "assistant",
      content: textItems.map((i) => i.content).join("\n\n"),
    };
  }
  // Items exist but none are text → tool-only turn. Skip per spec so the
  // preview doesn't get cluttered with "you: continue → tools → you: continue".
  if (items.length > 0) return null;
  // No items = turn still pending. Show user side so the reader sees what's
  // in flight.
  return { timestamp: turn.timestamp, role: "user", content: turn.userPrompt };
}

function renderPreviewLine(row, agentName) {
  const hhmm = formatHourMinute(row.timestamp);
  const who = row.role === "user" ? "you" : agentName;
  const preview = shortenForPreview(row.content);
  return `• ${hhmm} ${who}: ${preview}`;
}

/** Collapse code fences, take first line, trim to ~80 chars. */
export function shortenForPreview(text) {
  let t = String(text || "").trim();
  // Replace fenced code blocks with a marker before line-splitting so
  // multi-line fences don't eat the entire first-line rule.
  t = t.replace(/```[\s\S]*?```/g, "[code]");
  const hadNewline = /\n/.test(t);
  t = t.split("\n")[0].trim();
  let truncated = false;
  if (t.length > MAX_PREVIEW_CHARS) {
    t = t.slice(0, MAX_PREVIEW_CHARS - 1).trimEnd();
    truncated = true;
  }
  if (truncated || hadNewline) t += "…";
  return t;
}

function formatHourMinute(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "??:??";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
