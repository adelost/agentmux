// A Codex turn's own journal records the account's windows and credit balance after every model call. That reading is
// newer than the 15-minute account snapshot, and it is the only one that sees a window run out under a running turn
// (claw:5, 27 Oct 2026: primary 100 % at 07:56:59Z, 61 more calls, 88.723 credits, until Esc at 09:01:45Z).

import { codexUserPrompt } from "./codex-user-events.mjs";

const WINDOW_KIND = { 300: "session", 10_080: "week" };
const CALLS = new Set(["function_call", "custom_tool_call", "local_shell_call"]);
const OUTPUTS = new Set(["function_call_output", "custom_tool_call_output", "local_shell_call_output"]);

const isCreditsFlowing = credits => credits?.has_credits === true || credits?.unlimited === true;
const readingsOf = turn => turn.filter(event => event?.type === "event_msg" && event.payload?.type === "token_count" && event.payload.rate_limits)
  .map(event => event.payload.rate_limits);
const balanceOf = credits => { const balance = Number(credits?.balance); return Number.isFinite(balance) ? balance : null; };

/**
 * WHAT: Reads a turn's latest model call: a spent window, open tool calls and its prompts.
 * WHY: Keeps a turn from drawing credits on an account reading older than its own journal.
 */
export function codexCreditEvidence(events, { now }) {
  if (!Array.isArray(events)) return null;
  const start = events.findLastIndex(event => event?.type === "event_msg" && event.payload?.type === "task_started");
  const turn = events.slice(start + 1);
  const readings = readingsOf(turn);
  const limits = readings.at(-1);
  // Without credits the account refuses by itself, and the turn ends on its own.
  if (!limits || !isCreditsFlowing(limits.credits)) return null;
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
  const first = readings.find(reading => isCreditsFlowing(reading.credits) && [reading.primary, reading.secondary]
    .some(window => window?.window_minutes === spent.window_minutes && window.resets_at === spent.resets_at && window.used_percent >= 100));
  const startedAt = start >= 0 ? Date.parse(events[start].timestamp) : NaN;
  return { window: WINDOW_KIND[spent.window_minutes], resetsAt: spent.resets_at * 1000, balance: balanceOf(limits.credits),
    balanceAtFirstSpent: balanceOf(first.credits), turnId: start >= 0 ? events[start].payload.turn_id ?? null : null,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    prompts: start >= 0 ? turn.map(codexUserPrompt).filter(text => text !== null) : null, toolOpen: open.size > 0 };
}

/** WHAT: Reads the credit balance of a journal's latest model call, or null. WHY: Keeps a case's closing figure on the journal's own numbers. */
export const codexLastBalance = events => balanceOf(readingsOf(events || []).findLast(reading => reading.credits?.balance !== undefined)?.credits);
