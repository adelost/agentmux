// Compaction at a natural pause: a Claude pane over its budget is compacted
// once its turn has ended, instead of waiting for a 50-minute rest that busy
// builders never take. The paid compact itself runs through context
// maintenance, which owns the lease, the fence and the guarded submit.

import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PAUSE_COMPACT_POLICY } from "../policies/context-cost.mjs";
import { isCompactUnsafe, isLiveStatus } from "./pane-status.mjs";
import { parseJsonlText, readTailWindow } from "./jsonl-reader.mjs";

export const PAUSE_COMPACT_MODES = Object.freeze(["off", "dry", "on"]);

const readMode = (name, value) => {
  const mode = value || "dry";
  if (!PAUSE_COMPACT_MODES.includes(mode)) throw new Error(`${name} must be one of ${PAUSE_COMPACT_MODES.join(", ")}, got ${mode}`);
  return mode;
};

/**
 * WHAT: Reads, per engine, whether pause compaction is off, logging only, or live.
 * WHY: Keeps the first rollout a dry run, and Codex dry until its own switch is turned on.
 * The Codex measurements of 2026-10-11 found its cache warm at a pause (85% cached within 5 minutes).
 */
export function readPauseCompactModes(env = process.env) {
  return { claude: readMode("AUTO_COMPACT_PAUSE", env.AUTO_COMPACT_PAUSE),
    codex: readMode("AUTO_COMPACT_PAUSE_CODEX", env.AUTO_COMPACT_PAUSE_CODEX) };
}

/** WHAT: Lists the panes that lead an agent. WHY: Keeps the orchestrator and named leaders on one role definition. */
export const leaderPanes = (agentConfig) =>
  new Set([agentConfig?.orchestrator, ...(agentConfig?.leaders || [])].filter(Number.isSafeInteger));

/** WHAT: Picks a pane's pause budget. WHY: Keeps leaders, who carry the plan, from being compacted as often as builders. */
export const pauseCompactLimit = (agentConfig, pane, policy = PAUSE_COMPACT_POLICY) =>
  leaderPanes(agentConfig).has(pane) ? policy.leaderTokens : policy.builderTokens;

const hold = (cell, detail) => ({ action: "hold", cell, detail });

/**
 * WHAT: Decides whether a pane at a pause is compacted now, and against which budget.
 * WHY: Keeps every condition of the pause rule in one pure, testable place.
 * "none" means no pause or no need; "hold" means a due compact that a guard keeps, which is logged.
 * idleLimit and idleMs give Codex its own idle rule: above the daytime budget after 25 quiet minutes.
 */
export function pauseCompactDecision({ engine, tokens, limit, idleLimit = null, idleMs = null, status, inCopyMode = false, quietMs,
  background = null, lastCompactAt = null, now }, policy = PAUSE_COMPACT_POLICY) {
  if (!["claude", "codex"].includes(engine)) return { action: "none", cell: "no-compact-receipt" };
  const overPause = Number.isFinite(tokens) && tokens > limit;
  const overIdle = Number.isFinite(tokens) && Number.isFinite(idleLimit) && Number.isFinite(idleMs) && tokens > idleLimit;
  if (!overPause && !overIdle) return { action: "none", cell: "within-budget" };
  if (isLiveStatus(status)) return { action: "none", cell: "turn-running" };
  const pauseDue = overPause && quietMs >= policy.settleMs;
  const idleDue = overIdle && quietMs >= idleMs;
  if (!pauseDue && !idleDue) return { action: "none", cell: "settling" };
  if (inCopyMode) return hold("copy-mode", "the pane is in tmux copy-mode");
  if (isCompactUnsafe(status)) return hold("unsafe-status", `its status is ${status}`);
  if (background) return hold("background-active", background);
  if (Number.isFinite(lastCompactAt) && now - lastCompactAt < policy.spacingMs) {
    return hold("spacing", `compacted ${Math.round((now - lastCompactAt) / 60_000)} min ago`);
  }
  return pauseDue
    ? { action: "compact", cell: "pause", budget: limit, detail: `turn ended ${Math.round(quietMs / 1000)}s ago at ${tokens} tokens > ${limit}` }
    : { action: "compact", cell: "codex-idle", budget: idleLimit, detail: `idle ${Math.round(quietMs / 60_000)} min at ${tokens} tokens > ${idleLimit}` };
}

const newestMtimeMs = (dir) => {
  let newest = -Infinity;
  let names = [];
  try { names = readdirSync(dir); } catch { return newest; } // no subagents or jobs yet
  for (const name of names) {
    try { newest = Math.max(newest, statSync(join(dir, name)).mtimeMs); } catch { /* removed meanwhile, or a dangling link */ }
  }
  return newest;
};

/** WHAT: Lists start times of processes holding a file in dir open. WHY: Keeps a silent background job visible after its output stops changing. */
export function openFileHolderStarts(dir, procRoot = "/proc") {
  const btimeMs = Number(/^btime (\d+)$/mu.exec(readFileSync(join(procRoot, "stat"), "utf8"))?.[1]) * 1000;
  const starts = [];
  for (const pid of readdirSync(procRoot).filter((name) => /^\d+$/u.test(name))) {
    let fds = [];
    try { fds = readdirSync(join(procRoot, pid, "fd")); } catch { continue; } // exited or not ours
    const holds = fds.some((fd) => {
      try { return readlinkSync(join(procRoot, pid, "fd", fd)).startsWith(`${dir}/`); } catch { return false; }
    });
    if (!holds) continue;
    try {
      const stat = readFileSync(join(procRoot, pid, "stat"), "utf8");
      // Field 22 (starttime) counts clock ticks since boot; Linux reports 100 per second.
      const startTicks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
      starts.push(btimeMs + startTicks * 10);
    } catch { /* exited meanwhile */ }
  }
  return starts;
}

/**
 * WHAT: Names a subagent or background job of the session that is still working, or returns null.
 * WHY: Keeps a pane that only looks idle (its subagent builds, its gates run) from being compacted.
 * A holder older than hungJobMs is treated as hung: rg without a path waits on stdin forever.
 */
export function sessionBackgroundActivity({ sessionPath, sessionId, now, policy = PAUSE_COMPACT_POLICY,
  tmpRoot = join(tmpdir(), `claude-${process.getuid?.() ?? ""}`), procRoot = "/proc", holderStarts = openFileHolderStarts }) {
  const subagents = join(dirname(sessionPath), sessionId, "subagents");
  const tasks = join(tmpRoot, basename(dirname(sessionPath)), sessionId, "tasks");
  const newest = Math.max(newestMtimeMs(subagents), newestMtimeMs(tasks));
  if (now - newest < policy.backgroundQuietMs) return `a subagent or background job wrote ${Math.round((now - newest) / 1000)}s ago`;
  let starts = [];
  try { starts = holderStarts(tasks, procRoot); } catch { return null; } // no /proc: the write check above is all we have
  const youngest = Math.max(-Infinity, ...starts);
  return now - youngest < policy.hungJobMs ? `a background job has run for ${Math.round((now - youngest) / 60_000)} min` : null;
}

/** WHAT: Reads the newest compact in the session journal's tail. WHY: Keeps manual and the engine's own compacts inside the spacing window too. */
export function latestJournalCompactMs(sessionPath, { readTail = readTailWindow, tailBytes = 1024 * 1024 } = {}) {
  const records = parseJsonlText(readTail(sessionPath, tailBytes).text);
  // Claude writes a compact_boundary; Codex a "compacted" record and a context_compacted event.
  const times = records.filter((record) => (record?.type === "system" && record.subtype === "compact_boundary")
      || record?.type === "compacted" || record?.payload?.type === "context_compacted")
    .map((record) => Date.parse(record.timestamp)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

/**
 * WHAT: Lists start times of processes a Codex pane's terminals still run.
 * WHY: Keeps a Codex pane whose build or gate runs in a background terminal from looking idle.
 * The journal cannot tell: a command the model never polls again leaves no exit record (lsrc:4,
 * 2026-10-11). The pane's own helpers are skipped: code-mode-host, and children started with Codex (MCP servers).
 */
export function codexTerminalStarts(paneDir, procRoot = "/proc", { helperStartMs = 120_000 } = {}) {
  const btimeMs = Number(/^btime (\d+)$/mu.exec(readFileSync(join(procRoot, "stat"), "utf8"))?.[1]) * 1000;
  const procs = new Map();
  for (const pid of readdirSync(procRoot).filter((name) => /^\d+$/u.test(name))) {
    try {
      const stat = readFileSync(join(procRoot, pid, "stat"), "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      procs.set(pid, { ppid: fields[1], startMs: btimeMs + Number(fields[19]) * 10,
        args: readFileSync(join(procRoot, pid, "cmdline"), "utf8").split("\0") });
    } catch { /* exited meanwhile */ }
  }
  const isCodexBinary = (pid, proc) => /\/bin\/codex$/u.test(proc.args[0]) && (() => {
    try { return readlinkSync(join(procRoot, pid, "cwd")) === paneDir; } catch { return false; }
  })();
  const starts = [];
  for (const [pid, proc] of procs) {
    if (!isCodexBinary(pid, proc)) continue;
    const queue = [...procs].filter(([, child]) => child.ppid === pid).map(([childPid, child]) => [childPid, child, true]);
    while (queue.length) {
      const [childPid, child, direct] = queue.shift();
      if (child.args.some((arg) => arg.endsWith("codex-code-mode-host"))) continue;
      if (!(direct && child.startMs - proc.startMs < helperStartMs)) starts.push(child.startMs);
      queue.push(...[...procs].filter(([, grand]) => grand.ppid === childPid).map(([grandPid, grand]) => [grandPid, grand, false]));
    }
  }
  return starts;
}

const codexSessionsRoot = (sessionPath) => sessionPath.slice(0, sessionPath.lastIndexOf("/sessions/") + "/sessions".length);
const utcDayDir = (root, ms) => join(root, ...new Date(ms).toISOString().slice(0, 10).split("-"));

/** WHAT: Checks whether a Codex rollout belongs to a subagent of the given session. WHY: Keeps a working spawn_agent child visible from its parent pane. */
function isCodexChildOf(path, sessionId) {
  try {
    const meta = JSON.parse(readFileSync(path, "utf8").split("\n", 1)[0])?.payload;
    return meta?.forked_from_id === sessionId || meta?.source?.subagent?.thread_spawn?.parent_thread_id === sessionId;
  } catch { return false; } // unreadable or still being written: not evidence of a child
}

/**
 * WHAT: Names a Codex subagent or background terminal of the session that is still working, or returns null.
 * WHY: Gives Codex panes the same guard as Claude's subagents and background jobs.
 */
export function codexBackgroundActivity({ sessionPath, sessionId, paneDir, now, policy = PAUSE_COMPACT_POLICY,
  terminalStarts = codexTerminalStarts }) {
  const root = codexSessionsRoot(sessionPath);
  for (const day of new Set([utcDayDir(root, now), utcDayDir(root, now - 86_400_000)])) {
    let names = [];
    try { names = readdirSync(day); } catch { continue; } // no rollouts that day
    for (const name of names) {
      const path = join(day, name);
      if (path === sessionPath || !name.endsWith(".jsonl")) continue;
      let mtimeMs = -Infinity;
      try { mtimeMs = statSync(path).mtimeMs; } catch { continue; }
      if (now - mtimeMs < policy.backgroundQuietMs && isCodexChildOf(path, sessionId)) {
        return `a Codex subagent wrote ${Math.round((now - mtimeMs) / 1000)}s ago`;
      }
    }
  }
  let starts = [];
  try { starts = terminalStarts(paneDir); } catch { return null; } // no /proc: the subagent check above is all we have
  const running = starts.filter((startMs) => now - startMs < policy.hungJobMs);
  return running.length ? `${running.length} Codex terminal process(es) running, the oldest for ${Math.round((now - Math.min(...running)) / 60_000)} min` : null;
}
