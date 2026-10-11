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
 * WHAT: Decides whether a pane at a pause is compacted now.
 * WHY: Keeps every condition of the pause rule in one pure, testable place.
 * "none" means no pause or no need; "hold" means an over-budget pause that a guard keeps, which is logged.
 */
export function pauseCompactDecision({ engine, tokens, limit, status, inCopyMode = false, quietMs, background = null, lastCompactAt = null, now },
  policy = PAUSE_COMPACT_POLICY) {
  if (!["claude", "codex"].includes(engine)) return { action: "none", cell: "no-compact-receipt" };
  if (!Number.isFinite(tokens) || tokens <= limit) return { action: "none", cell: "within-budget" };
  if (isLiveStatus(status)) return { action: "none", cell: "turn-running" };
  if (!Number.isFinite(quietMs) || quietMs < policy.settleMs) return { action: "none", cell: "settling" };
  if (inCopyMode) return hold("copy-mode", "the pane is in tmux copy-mode");
  if (isCompactUnsafe(status)) return hold("unsafe-status", `its status is ${status}`);
  if (background) return hold("background-active", background);
  if (Number.isFinite(lastCompactAt) && now - lastCompactAt < policy.spacingMs) {
    return hold("spacing", `compacted ${Math.round((now - lastCompactAt) / 60_000)} min ago`);
  }
  return { action: "compact", cell: "pause", detail: `turn ended ${Math.round(quietMs / 1000)}s ago at ${tokens} tokens > ${limit}` };
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

/** WHAT: Reads the newest compact boundary in the session journal's tail. WHY: Keeps manual and Claude's own compacts inside the spacing window too. */
export function latestJournalCompactMs(sessionPath, { readTail = readTailWindow, tailBytes = 1024 * 1024 } = {}) {
  const records = parseJsonlText(readTail(sessionPath, tailBytes).text);
  const times = records.filter((record) => record?.type === "system" && record.subtype === "compact_boundary")
    .map((record) => Date.parse(record.timestamp)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}
