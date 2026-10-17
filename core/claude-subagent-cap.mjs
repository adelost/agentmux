// Agent/Task admission rides on the existing Claude command hook. No scheduler or model calls.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireFileLease } from "./file-lease.mjs";
import { parseRuntimeEnv } from "./runtime-env.mjs";

/** WHAT: Returns the requested refusal text. WHY: Keeps every refused spawn on the same implementation handoff policy. */
export const SUBAGENT_REFUSAL = "One subagent at a time. Hand mechanical work to a free Codex pane with a brief (policy: Opus designs; Codex implements).";
const tools = new Set(["Agent", "Task"]);
const lifecycle = new Set(["SubagentStart", "SubagentStop", "PostToolUse", "PostToolUseFailure", "SessionStart"]);

/** WHAT: Reads the operator's current cap. WHY: Existing Claude processes need no restart for an env-file change. */
function capOf(home, env) {
  const path = env.AMUX_DISCORD_ENV || join(home, ".agentmux", ".env");
  const file = existsSync(path) ? parseRuntimeEnv(readFileSync(path, "utf8")) : {};
  const raw = file.AMUX_CLAUDE_SUBAGENT_CAP ?? env.AMUX_CLAUDE_SUBAGENT_CAP ?? "1";
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw))) throw Error("unknown-cap");
  return Number(raw);
}

/** WHAT: Updates slots from Claude's own tool/lifecycle receipts. WHY: A launched background tool result is not completion. */
function update(state, payload) {
  const event = payload.hook_event_name, id = payload.tool_use_id, agent = payload.agent_id;
  if (event === "SessionStart") {
    if (!agent && state.session !== payload.session_id) return { session: payload.session_id, slots: [] };
  } else if (event === "SubagentStart" && agent) {
    if (state.slots.some(slot => slot.agent === agent)) return state;
    const pending = state.slots.find(slot => !slot.agent && slot.type === payload.agent_type)
      || state.slots.find(slot => !slot.agent);
    if (pending) pending.agent = agent;
    else state.slots.push({ id: `agent:${agent}`, agent });
  } else if (event === "SubagentStop" && agent) {
    state.slots = state.slots.filter(slot => slot.agent !== agent);
  } else if (event === "PostToolUseFailure" || event === "PostToolUse") {
    state.slots = state.slots.filter(slot => slot.id !== id || (event === "PostToolUse" && slot.background));
  }
  return state;
}

/** WHAT: Serializes admission using AMUX's kernel-backed lease. WHY: Two parallel PreToolUse processes cannot both see zero. */
async function leaseAt(path) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const lease = acquireFileLease(path);
    if (lease) return lease;
    await delay(10);
  }
  throw Error("count-lock-busy");
}

/** WHAT: Checks one spawn or consumes a lifecycle receipt. WHY: Keeps an unknown count from blocking work. */
export async function claudeSubagentHook(payload, { pane, home = homedir(), env = process.env, forkRefusal = null } = {}) {
  const spawn = payload.hook_event_name === "PreToolUse" && tools.has(payload.tool_name);
  const receipt = lifecycle.has(payload.hook_event_name)
    && (!payload.hook_event_name.startsWith("PostTool") || tools.has(payload.tool_name));
  if (!pane || (!spawn && !receipt)) return { allowed: true };
  const dir = join(home, ".agentmux"), stateDir = join(dir, "subagent-cap");
  const key = createHash("sha256").update(pane).digest("hex");
  const path = join(stateDir, `${key}.json`);
  let lease, verdict = { allowed: true, countKnown: false, reason: "count-unavailable" };
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    lease = await leaseAt(join(stateDir, `${key}.lock`));
    const present = existsSync(path);
    let state = present ? JSON.parse(readFileSync(path, "utf8")) : { session: payload.session_id, slots: [] };
    if (!Array.isArray(state.slots)) throw Error("unknown-state");
    if (spawn) {
      const cap = capOf(home, env), own = state.slots.find(slot => slot.id === payload.tool_use_id);
      verdict = { allowed: !forkRefusal && (cap === 0 || !!own || state.slots.length < cap),
        countKnown: present, running: state.slots.length, cap, reason: present ? "counted" : "first-observation" };
      if (verdict.allowed && !own) {
        if (!payload.tool_use_id || !payload.session_id) throw Error("missing-call-identity");
        state.slots.push({ id: payload.tool_use_id, type: payload.tool_input?.subagent_type,
          background: payload.tool_input?.run_in_background === true });
      }
      verdict.refusal = forkRefusal || (verdict.allowed ? null : SUBAGENT_REFUSAL);
    } else state = update(state, payload);
    writeFileSync(path, JSON.stringify(state) + "\n", { mode: 0o600 });
  } catch {
    verdict = { allowed: !forkRefusal, countKnown: false, reason: "count-unavailable", refusal: forkRefusal };
  } finally { lease?.release(); }
  if (spawn) {
    // Only the tool's description, never prompt, transcript contents or tool_response.
    const row = { time: new Date().toISOString(), pane, allowed: verdict.allowed,
      description: String(payload.tool_input?.description ?? ""), countKnown: verdict.countKnown,
      reason: verdict.reason, ...(verdict.running === undefined ? {} : { running: verdict.running, cap: verdict.cap }) };
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(join(dir, "subagent-spawns.jsonl"), JSON.stringify(row) + "\n", { mode: 0o600 });
    } catch {
      console.error("[amux-hook] subagent spawn audit unavailable; allowing the call");
      return { allowed: true, countKnown: false };
    }
  }
  return verdict;
}
