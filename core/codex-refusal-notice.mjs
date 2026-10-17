// A Codex turn can close before any model runs, when OpenAI refuses the
// request (an unsupported model, a model at capacity). The journal then holds
// the prompt and task_complete but no reply, so the pane looked silent: on
// 2026-10-02 two "Hej" to lsrc:4 on gpt-6.1 got nothing back. Codex logs the
// refusal itself in CODEX_HOME/logs_2.sqlite, keyed by thread and time, and
// keeps about the last 1000 rows per thread, so it is read right away.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { codexPromptProgress, codexUserPrompt, iterateCodexUserEvents } from "./codex-user-events.mjs";

const clock = (iso) => new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
const THREAD_FILE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u;
const TURN_ERROR = "run_turn: Turn error:";

/** WHAT: Returns unanswered Codex ends, including failed requests mid-turn. WHY: Keeps earlier usage from hiding a later provider refusal. */
export function codexRefusals(events) {
  const prompts = codexPromptProgress();
  const refusals = [];
  let promptAt = null;
  for (const event of iterateCodexUserEvents(events)) {
    const seen = prompts.see(event);
    if (seen === "prompt") promptAt = event.timestamp || null;
    if (event.payload?.type === "task_started") promptAt ??= event.timestamp || null;
    const unanswered = event.type === "event_msg" && event.payload?.type === "task_complete"
      && event.payload.last_agent_message === null;
    if (seen === "refused" || unanswered) {
      const id = event.__hash || event.timestamp;
      if (id) refusals.push({ id, timestamp: event.timestamp || null, promptAt,
        ...(event.payload.turn_id ? { turnId: event.payload.turn_id } : {}),
        ...(seen !== "refused" ? { requiresError: true } : {}) });
      promptAt = null;
    }
    if (event.payload?.type === "task_complete" || event.payload?.type === "turn_aborted") promptAt = null;
  }
  return refusals;
}

/** WHAT: Reads the last authored input in the bounded journal window. WHY: Keeps newer human or agent input from receiving an obsolete continuation. */
export function codexLastPrompt(events) {
  let last = null;
  for (const event of iterateCodexUserEvents(events)) {
    const text = codexUserPrompt(event);
    if (text !== null) last = { timestamp: event.timestamp, text };
  }
  return last;
}

/** WHAT: Returns exact provider reasons for unanswered ends. WHY: Prevents successful empty endings from becoming refusal notices. */
export async function confirmedCodexRefusals(result, home, readError = codexTurnError) {
  const threadId = codexThreadOfRollout(result?.jsonlFile);
  const confirmed = [];
  for (const refusal of result?.refusals || []) {
    const reason = await readError({ home, threadId, refusal });
    if (!refusal.requiresError || reason) confirmed.push({ ...refusal, reason });
  }
  return confirmed;
}

/** WHAT: Returns the Codex thread id a rollout file belongs to. WHY: Keeps the log lookup on the exact session. */
export const codexThreadOfRollout = (file) => THREAD_FILE.exec(String(file || ""))?.[1] || null;

function readableTurnError(body) {
  const text = body.slice(body.indexOf(TURN_ERROR) + TURN_ERROR.length).trim();
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || parsed?.message || text;
  } catch {
    return text.split("\n")[0];
  }
}

/** WHAT: Reads the refusal Codex logged for one turn. WHY: Keeps the notice on the provider's own words instead of a guess. */
export async function codexTurnError({ home, threadId, refusal }) {
  const path = join(home, "logs_2.sqlite");
  const end = Date.parse(refusal?.timestamp || "");
  if (!threadId || !Number.isFinite(end) || !existsSync(path)) return null;
  const start = Date.parse(refusal.promptAt || "");
  const { DatabaseSync } = await import("node:sqlite");
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare(`SELECT feedback_log_body AS body FROM logs
      WHERE thread_id = ? AND ts BETWEEN ? AND ? AND feedback_log_body LIKE ?
      AND feedback_log_body LIKE ? ORDER BY id DESC LIMIT 1`)
      .get(threadId, Math.floor((Number.isFinite(start) ? start : end) / 1000) - 1, Math.ceil(end / 1000) + 2,
        `%${TURN_ERROR}%`, refusal.turnId ? `%${refusal.turnId}%` : "%");
    return row?.body ? readableTurnError(String(row.body)).slice(0, 300) : null;
  } catch {
    // A locked or changed log schema only loses the reason, never the notice.
    return null;
  } finally { db?.close(); }
}

/** WHAT: Formats the notice for turns that got no answer. WHY: Keeps the sender from waiting on a pane that will not reply. */
export function refusalNoticeText(paneName, refusals, reason, { autoCapacity = false } = {}) {
  const times = refusals.map((r) => r.timestamp).filter((ts) => Number.isFinite(Date.parse(ts))).map(clock);
  const when = times.length ? ` (${times.join(", ")})` : "";
  const what = refusals.length === 1 ? "a message" : `${refusals.length} messages`;
  if (!autoCapacity && !refusals.some(refusal => refusal.requiresError)) {
    const why = reason ? `Codex stopped before any model ran: ${reason}` : "Codex stopped before any model ran; the pane shows why.";
    return `**${paneName}** did not answer ${what}${when}. ${why} Nothing was processed, so send it again once this is fixed.`;
  }
  const why = reason ? `Codex stopped: ${reason}` : "Codex stopped before any model ran; the pane shows why.";
  const next = autoCapacity ? "AMUX will wait and continue automatically, up to three attempts, unless new input arrives."
    : "Continue the task once this is fixed.";
  return `**${paneName}** did not finish ${what}${when}. ${why} ${next}`;
}
