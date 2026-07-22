// Fail-closed local observations used by pane sleep. Kept separate from the
// lifecycle command so the safety probes remain small and independently tested.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listAgents } from "./config.mjs";
import { detectPaneStatus } from "./format.mjs";
import { TERMINAL_DELIVERY_STATES } from "../core/delivery-queue.mjs";
import { latestPaneStatesCached, mergeStatus } from "../core/events.mjs";
import { latestClaudeSessionIdentity } from "../core/native-session-identity.mjs";
import { latestConversationActivityMs } from "../core/pane-activity.mjs";
import { PANE_SLEEP_IDLE_MS, planSleep } from "../core/pane-sleep.mjs";

const CLAUDE_COMMAND = /(?:^|\s)claude(?:\s|$)/u;
const EXCLUDED_PANE = /manager|broker|service|native/u;
const GIT_QUIET = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };

/** WHAT: Resolves one configured agent. WHY: Keeps sleep probes bound to declared fleet targets. */
export function agentEntry(ctx, agentName, agents) {
  return (agents || listAgents(ctx.configPath)).find((agent) => agent.name === agentName) || null;
}

/** WHAT: Resolves one pane declaration. WHY: Keeps runtime observations tied to the requested pane. */
export function paneDefinition(agent, pane) {
  return Array.isArray(agent?.panes) ? agent.panes[Number(pane)] || null : null;
}

/** WHAT: Resolves a pane worktree path. WHY: Keeps cleanliness and journal probes on one filesystem target. */
export function paneDirectory(agent, pane) {
  return join(agent.dir, ".agents", String(Number(pane)));
}

function countLiveDeliveryJobs(queue, agentName, pane) {
  try {
    return queue.list(agentName, pane)
      .filter((job) => !TERMINAL_DELIVERY_STATES.has(job.status)).length;
  } catch {
    return NaN;
  }
}

function probeWorktree(paneDir, exec) {
  try {
    const status = exec("git", ["-C", paneDir, "status", "--porcelain"], GIT_QUIET);
    const rebase = ["rebase-merge", "rebase-apply"].some((kind) => {
      const gitPath = exec("git", ["-C", paneDir, "rev-parse", "--git-path", kind], GIT_QUIET).trim();
      return existsSync(resolve(paneDir, gitPath));
    });
    return { clean: status.trim() === "", rebase };
  } catch {
    return { clean: null, rebase: null };
  }
}

function attachedToSession(agentName, ctx, exec) {
  try {
    const sessions = exec("tmux", [
      "-S", ctx.socket, "list-clients", "-F", "#{client_session}",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").map((value) => value.trim()).filter(Boolean);
    return sessions.includes(agentName);
  } catch {
    return null;
  }
}

function paneShellPid(agentName, pane, ctx, exec) {
  try {
    return Number(exec("tmux", [
      "-S", ctx.socket, "display", "-p", "-t", `${agentName}:.${pane}`, "#{pane_pid}",
    ], GIT_QUIET).trim()) || null;
  } catch {
    return null;
  }
}

function codingProcessGeneration(agentName, pane, ctx, exec, readFile = readFileSync) {
  const rootPid = paneShellPid(agentName, pane, ctx, exec);
  if (!rootPid) return null;
  let rows;
  try {
    rows = exec("ps", ["-eo", "pid=,ppid=,comm="], GIT_QUIET);
  } catch {
    return null;
  }
  const children = new Map();
  for (const line of rows.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/u);
    if (!match) continue;
    const row = { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
    const existing = children.get(row.ppid) || [];
    existing.push(row);
    children.set(row.ppid, existing);
  }
  const pending = [rootPid];
  const coding = [];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    for (const child of children.get(pending[cursor]) || []) {
      pending.push(child.pid);
      if (/^(?:claude|node)$/u.test(child.command)) {
        try {
          const fields = readFile(`/proc/${child.pid}/stat`, "utf8").trim().split(/\s+/u);
          coding.push(`${child.pid}:${fields[21] || "unknown"}:${child.command}`);
        } catch {
          return null;
        }
      }
    }
  }
  return coding.length ? `${rootPid}:${coding.sort().join(",")}` : null;
}

/** WHAT: Collects one fail-closed sleep observation. WHY: Keeps unknown work or transport state from authorizing sleep. */
export async function observePane(ctx, agent, pane, {
  exec,
  queue,
  readFile,
  expectedProcessGeneration = null,
  expectedSessionId = null,
  requireIdle = true,
  nowMs,
  activity = latestConversationActivityMs,
} = {}) {
  const definition = paneDefinition(agent, pane);
  const dir = paneDirectory(agent, pane);
  const engine = CLAUDE_COMMAND.test(String(definition?.cmd || "")) ? "claude" : "unsupported";
  // V1 can prove exact compact, exit, and resume receipts only for Claude.
  // Return before tmux/process/git probes for every other engine: scanning the
  // whole mixed fleet made one read-only sweep take tens of seconds without
  // producing any additional eligible candidate.
  if (engine !== "claude") {
    return {
      ok: false,
      reason: "unsupported-engine",
      facts: { engine },
      identity: null,
      processGeneration: null,
      lastActivityMs: null,
    };
  }
  const lastActivityMs = activity(dir, engine);
  const idleMs = Number.isFinite(lastActivityMs)
    ? Number(nowMs) - Number(lastActivityMs)
    : NaN;
  // Activity is the cheapest and strongest rejection. Do not run `ps`, git
  // status, tmux captures, or transport probes for the normal recent case.
  // This turns a fleet sweep from one expensive probe bundle per Claude pane
  // into deep inspection only for genuinely old candidates.
  if (requireIdle && !Number.isFinite(idleMs)) {
    return {
      ok: false,
      reason: "activity-unknown",
      facts: { engine, idleMs },
      identity: null,
      processGeneration: null,
      lastActivityMs,
    };
  }
  if (requireIdle && idleMs < PANE_SLEEP_IDLE_MS) {
    return {
      ok: false,
      reason: "idle-threshold-not-met",
      facts: { engine, idleMs },
      identity: null,
      processGeneration: null,
      lastActivityMs,
    };
  }
  const identity = engine === "claude" ? latestClaudeSessionIdentity(dir) : null;
  const processState = await Promise.resolve(ctx.agent.paneProcessState(agent.name, pane)).catch(() => null);
  const processGeneration = codingProcessGeneration(agent.name, pane, ctx, exec, readFile);
  const transport = await ctx.agent.promptTransportState(agent.name, pane, "").catch(() => null);
  const busy = await ctx.agent.isBusy(agent.name, pane).catch(() => null);
  const capture = await ctx.agent.capturePane(agent.name, pane, 100).catch(() => null);
  const paneStatus = capture
    ? mergeStatus(detectPaneStatus(capture),
      latestPaneStatesCached().get(`${agent.name}:${pane}`)).status
    : null;
  const worktree = probeWorktree(dir, exec);
  const facts = {
    engine,
    idleMs: requireIdle ? idleMs : PANE_SLEEP_IDLE_MS,
    busy,
    paneStatus,
    transportState: transport?.state || null,
    liveDeliveryJobs: countLiveDeliveryJobs(queue, agent.name, pane),
    worktreeClean: worktree.clean,
    rebaseInProgress: worktree.rebase,
    processRunning: processState?.running === true && processGeneration !== null,
    attached: attachedToSession(agent.name, ctx, exec),
    excluded: agent.backend === "native"
      || EXCLUDED_PANE.test(`${definition?.name || ""} ${definition?.role || ""}`.toLowerCase()),
  };
  const plan = planSleep(facts);
  if (plan.allow && expectedProcessGeneration && processGeneration !== expectedProcessGeneration) {
    return { ok: false, reason: "process-generation-changed", facts };
  }
  if (plan.allow && expectedSessionId && identity?.sessionId !== expectedSessionId) {
    return { ok: false, reason: "session-changed", facts };
  }
  return {
    ok: plan.allow,
    reason: plan.reason,
    facts,
    identity,
    processGeneration,
    lastActivityMs,
  };
}

/** WHAT: Checks a bounded receipt condition. WHY: Keeps sleep transitions from waiting forever. */
export async function poll(attempts, delayMs, sleep, predicate) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return true;
    if (attempt + 1 < attempts) await sleep(delayMs);
  }
  return false;
}

export function exactResponse(result) {
  if (result?.source !== "jsonl" || !Array.isArray(result.items)) return null;
  if (result.items.some((item) => item.type !== "text")) return null;
  return result.items.map((item) => item.content).join("\n\n").trim() || null;
}
