// A Codex turn's own journal records the account's windows and credit balance after every model call. That reading is
// newer than the 15-minute account snapshot, and it is the only one that sees a window run out under a running turn
// (claw:5, 27 Oct 2026: primary 100 % at 07:56:59Z, 61 more calls, 88.723 credits, until Esc at 09:01:45Z).

const WINDOW_KIND = { 300: "session", 10_080: "week" };
const CALLS = new Set(["function_call", "custom_tool_call", "local_shell_call"]);
const OUTPUTS = new Set(["function_call_output", "custom_tool_call_output", "local_shell_call_output"]);

/**
 * WHAT: Reads a turn's latest model call: a spent window with credits flowing, and open tool calls.
 * WHY: Keeps a turn from drawing credits on an account reading older than its own journal.
 */
export function codexCreditEvidence(events, { now }) {
  if (!Array.isArray(events)) return null;
  const start = events.findLastIndex(event => event?.type === "event_msg" && event.payload?.type === "task_started");
  const turn = events.slice(start + 1);
  const limits = turn.findLast(event => event?.type === "event_msg" && event.payload?.type === "token_count" && event.payload.rate_limits)
    ?.payload.rate_limits;
  const credits = limits?.credits;
  // Without credits the account refuses by itself, and the turn ends on its own.
  if (!limits || !(credits?.has_credits === true || credits?.unlimited === true)) return null;
  const spent = [limits.primary, limits.secondary].filter(window => WINDOW_KIND[window?.window_minutes]
    && window.used_percent >= 100 && window.resets_at * 1000 > now)
    .sort((left, right) => right.resets_at - left.resets_at)[0];
  if (!spent) return null;
  const open = new Set();
  for (const { type, payload } of turn) {
    if (type !== "response_item" || !payload?.call_id) continue;
    if (CALLS.has(payload.type)) open.add(payload.call_id);
    else if (OUTPUTS.has(payload.type)) open.delete(payload.call_id);
  }
  const balance = Number(credits.balance);
  return { window: WINDOW_KIND[spent.window_minutes], resetsAt: spent.resets_at * 1000,
    balance: Number.isFinite(balance) ? balance : null,
    turnId: start >= 0 ? events[start].payload.turn_id ?? null : null, toolOpen: open.size > 0 };
}
