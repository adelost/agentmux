// Agent/Task admission rides on the existing Claude command hook. No scheduler or model calls.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireFileLease } from "./file-lease.mjs";
import { parseRuntimeEnv } from "./runtime-env.mjs";
import { extractPromptFromEvent } from "./claude-prompt-text.mjs";

/** WHAT: Returns the requested refusal text. WHY: Keeps every refused spawn on the same implementation handoff policy. */
export const SUBAGENT_REFUSAL = "One subagent at a time. Follow the amux handoff policy for an available authorized builder; keep visual and gameplay judgment with its owner.";
const tools = new Set(["Agent", "Task"]);
// Claude Code sends no SubagentStop for an agent TaskStop ends (sandman:0's floor agent, 2026-10-19 21:23Z).
const STOP_TOOL = "TaskStop";
// WSL's boot time drifts (46 s within four hours on 2026-10-19), and with it a process start read from /proc.
const START_MARGIN_MS = 2 * 60_000;
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
    // A started or resumed Claude process runs none of an earlier process's agents, and it sends them no stop.
    if (!agent && (state.session !== payload.session_id || ["startup", "resume"].includes(payload.source))) {
      return { session: payload.session_id, slots: [] };
    }
  } else if (event === "SubagentStart" && agent) {
    if (state.slots.some(slot => slot.agent === agent)) return state;
    const pending = state.slots.find(slot => !slot.agent && slot.type === payload.agent_type)
      || state.slots.find(slot => !slot.agent);
    if (pending) Object.assign(pending, { agent, startedAt: Date.now() });
    else state.slots.push({ id: `agent:${agent}`, agent, startedAt: Date.now() });
  } else if (event === "SubagentStop" && agent) {
    state.slots = state.slots.filter(slot => slot.agent !== agent);
  } else if (event === "PostToolUse" && payload.tool_name === STOP_TOOL) {
    state.slots = state.slots.filter(slot => !slot.agent || slot.agent !== payload.tool_input?.task_id);
  } else if (event === "PostToolUseFailure" || event === "PostToolUse") {
    state.slots = state.slots.filter(slot => slot.id !== id || (event === "PostToolUse" && slot.background));
  }
  return state;
}

/** WHAT: Returns when the Claude process above this hook started, or null. WHY: Keeps agents gone with an earlier process from counting. */
export function claudeProcessStartMs(procRoot = "/proc", pid = process.ppid) {
  try {
    const bootMs = Number(/^btime (\d+)$/mu.exec(readFileSync(join(procRoot, "stat"), "utf8"))?.[1]) * 1000;
    // Claude runs a hook directly or through `sh -c`, so its process is the first one named claude above it.
    for (let hops = 0; pid > 1 && hops < 8; hops++) {
      const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      // Field 22 (starttime) counts clock ticks since boot; Linux reports 100 per second.
      if (basename(readFileSync(join(procRoot, String(pid), "cmdline"), "utf8").split("\0")[0]) === "claude") {
        return bootMs + Number(fields[19]) * 10;
      }
      pid = Number(fields[1]);
    }
  } catch { /* no /proc or an exited parent: only the stop receipts apply */ }
  return null;
}

/** WHAT: Reads when each agent last stopped, from its task notifications in the parent journal. WHY: Keeps a stopped agent from holding a slot. */
function agentStops(journalPath, agents) {
  const stops = new Map();
  let journal;
  try { journal = agents.length ? readFileSync(journalPath) : null; } catch { return stops; }
  for (const agent of journal ? agents : []) {
    // Claude writes one notification each time an agent stops, whether it finished, failed or was stopped.
    const needle = Buffer.from(`<task-id>${agent}</task-id>`);
    for (let at = journal.lastIndexOf(needle); at >= 0; at = at > 0 ? journal.lastIndexOf(needle, at - 1) : -1) {
      const end = journal.indexOf(10, at);
      let record;
      try { record = JSON.parse(journal.toString("utf8", journal.lastIndexOf(10, at) + 1, end < 0 ? journal.length : end)); } catch { continue; }
      if (!String(extractPromptFromEvent(record) ?? "").trimStart().startsWith("<task-notification>")) continue;
      stops.set(agent, Date.parse(record.timestamp));
      break;
    }
  }
  return stops;
}

/**
 * WHAT: Returns the slots whose agents may still run.
 * WHY: Prevents a stopped agent, or one gone with an earlier Claude process, from refusing every later spawn.
 */
function liveSlots({ session, slots }, { transcript_path: transcript }, claudeStartedMs) {
  if (!transcript || !session) return slots;
  const stops = agentStops(join(dirname(transcript), `${session}.jsonl`), slots.map(slot => slot.agent).filter(Boolean));
  return slots.filter(slot => {
    if (slot.agent && stops.get(slot.agent) >= (slot.startedAt ?? -Infinity)) return false;
    if (claudeStartedMs === null) return true;
    const before = claudeStartedMs - START_MARGIN_MS;
    if (!slot.agent) return !(slot.at < before);
    try {
      return statSync(join(dirname(transcript), session, "subagents", `agent-${slot.agent}.jsonl`)).mtimeMs >= before;
    } catch { return true; } // without its journal the slot keeps counting
  });
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
export async function claudeSubagentHook(payload, {
  pane, home = homedir(), env = process.env, forkRefusal = null, claudeStartMs = claudeProcessStartMs,
} = {}) {
  const spawn = payload.hook_event_name === "PreToolUse" && tools.has(payload.tool_name);
  const receipt = lifecycle.has(payload.hook_event_name)
    && (!payload.hook_event_name.startsWith("PostTool") || tools.has(payload.tool_name) || payload.tool_name === STOP_TOOL);
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
      if (cap !== 0 && !own && state.slots.length >= cap) state.slots = liveSlots(state, payload, claudeStartMs());
      verdict = { allowed: !forkRefusal && (cap === 0 || !!own || state.slots.length < cap),
        countKnown: present, running: state.slots.length, cap, reason: present ? "counted" : "first-observation" };
      if (verdict.allowed && !own) {
        if (!payload.tool_use_id || !payload.session_id) throw Error("missing-call-identity");
        state.slots.push({ id: payload.tool_use_id, type: payload.tool_input?.subagent_type,
          background: payload.tool_input?.run_in_background === true, at: Date.now() });
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
