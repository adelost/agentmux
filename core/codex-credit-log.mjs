// The credit guard's cases, one JSON line each, for `amux quota` and for the week shift's reading (lsrc:0 for api:0,
// 2026-10-27: a sum over 5 credits in a week builds the hold in delivery-wake).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseJsonlText } from "./jsonl-reader.mjs";

/** WHAT: Names the file `amux quota` reads. WHY: Keeps the guard and the quota view on one log. */
export const CREDIT_STOP_LOG = join(homedir(), ".agentmux", "codex-credit-stop.jsonl");
const WEEK_MS = 7 * 86_400_000;
const LIMIT_CREDITS = 5;

/** WHAT: Stores one credit-guard case line. WHY: Keeps every Esc and every owner turn left running readable at the week shift. */
export function appendCreditStopLine(line, path = CREDIT_STOP_LOG) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`);
}

/** WHAT: Reads the last week's cases: stopped turns, owner turns left running and credits drawn. WHY: Keeps the 5 credit limit measurable. */
export function readCreditStopWeek({ now = Date.now(), path = CREDIT_STOP_LOG } = {}) {
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return { stopped: 0, ownerTurns: 0, credits: 0 }; }
  const cases = new Map();
  for (const line of parseJsonlText(text)) {
    if (!(Date.parse(line.at) > now - WEEK_MS) || typeof line.case !== "string") continue;
    const known = cases.get(line.case);
    // A case is what it began as (esc or owner-turn), counted at the latest figure it reached.
    cases.set(line.case, { kind: known?.kind ?? line.kind, credits: Number.isFinite(line.creditsDrawn) ? line.creditsDrawn : known?.credits ?? 0 });
  }
  const all = [...cases.values()];
  return { stopped: all.filter(entry => entry.kind === "esc").length, ownerTurns: all.filter(entry => entry.kind === "owner-turn").length,
    credits: Number(all.reduce((sum, entry) => sum + entry.credits, 0).toFixed(3)) };
}

/** WHAT: Formats the week's cases for `amux quota`. WHY: Keeps the guard's work visible beside the credit balance. */
export function creditStopText({ stopped, ownerTurns, credits }) {
  if (!stopped && !ownerTurns) return "Codex credit guard, 7 days: no case";
  return `Codex credit guard, 7 days: ${stopped} stopped, ${ownerTurns} owner turn${ownerTurns === 1 ? "" : "s"} left running, ${credits} credits drawn`
    + `${credits > LIMIT_CREDITS ? ` (over the ${LIMIT_CREDITS} credit limit)` : ""}`;
}
