// Command dispatch for agent CLI. Routes argv to handlers.
// Intent-driven: each command is a clear function name.

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { loadConfig, listAgents, getAgent, addAgent, removeAgent, resolveAgent, saveLast, getLast, getPaneCount, findChannelForPane } from "./config.mjs";
import { formatAgentRow, statusIcon, truncate, formatContextCell, formatTokens } from "./format.mjs";
import { hasSession, ensureAndAttach, attachSession, killSession, listPanes, getPaneStatus, sendKeys, selectOption, createTmuxContext, sendToPane } from "./tmux.mjs";
import { extractText, extractLastTurn, classifyLines, extractSegments } from "../core/extract.mjs";
import { stripAnsi, esc, extractActivity, formatDuration } from "../lib.mjs";
import { getContextFromPane } from "../core/context.mjs";
import { readLastTurns, parseSinceArg, readAllTurnsAcrossPanes, panePathFor } from "../core/jsonl-reader.mjs";
import { detectSenderFromEnv, prependSenderHeader } from "../core/sender-detect.mjs";
import {
  loadCheckpoint, saveCheckpoint, CHECKPOINT_PATH,
  groupByPane, classifyPane, previewText,
} from "../core/orchestrator-checkpoint.mjs";
import { regenerateAgentsYaml } from "../sync.mjs";
import yaml from "js-yaml";
import { spawn, execSync } from "child_process";
import { runOneshot, showRunLog } from "./run.mjs";
import { executePlan, showPlanLog } from "./plan.mjs";
import { showEvents } from "./events.mjs";

// Bridge = the Discord bot itself (not a Claude agent). Singleton infra.
const BRIDGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_SESSION = "amux";

// --- Flag parsing ---

/** Parse CLI flags from args array. Returns { flags, positional }. */
export function parseFlags(args, spec = {}) {
  const flags = {};
  const positional = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    // Check for --flag and -f variants
    const flagName = arg.startsWith("--") ? arg.slice(2) : arg.startsWith("-") ? arg.slice(1) : null;
    if (flagName && flagName in spec) {
      if (spec[flagName] === "boolean") {
        flags[flagName] = true;
        i++;
      } else {
        flags[flagName] = spec[flagName] === "number" ? parseInt(args[i + 1]) : args[i + 1];
        i += 2;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { flags, positional };
}

// --- Command handlers ---

async function cmdList(ctx) {
  const agents = listAgents(ctx.configPath);
  if (!agents.length) {
    console.log("No agents configured.");
    return;
  }
  for (const a of agents) {
    const running = await hasSession(ctx, a.name);
    console.log(formatAgentRow(a.index, a.name, a.dir, running, a.panes.length));
  }
  console.log("\n  agent <name|:nr> to attach | agent add <name> <dir> | agent rm <name> | agent r to resume last");
}

async function cmdAttach(name, ctx) {
  if (process.env.TMUX) {
    console.error(`Already inside tmux. Use 'agent ${name} "prompt"' to send, or detach first (prefix+d).`);
    process.exit(1);
  }
  saveLast(ctx.lastFile, name);
  getAgent(ctx.configPath, name); // validate exists
  await ensureAndAttach(ctx, name, ctx.configPath);
  attachSession(ctx.socket, name);
}

async function cmdStop(name, ctx) {
  if (!(await hasSession(ctx, name))) {
    console.log(`No tmux session for '${name}'.`);
    return;
  }
  await killSession(ctx, name);
  console.log(`Stopped '${name}'.`);
}

async function cmdReconcile(name, ctx) {
  const result = await ctx.agent.reconcileSession(name);
  if (result.skipped) {
    console.log(`Reconcile '${name}' skipped: ${result.reason}.`);
    return;
  }
  const parts = [];
  if (result.added) parts.push(`${result.added} added`);
  if (result.respawned?.length) parts.push(`${result.respawned.length} respawned`);
  if (result.unchanged) parts.push(`${result.unchanged} unchanged`);
  if (result.extras) parts.push(`${result.extras} extras`);
  console.log(`Reconciled '${name}': ${parts.join(", ") || "nothing to do"}.`);
  for (const r of result.respawned || []) {
    console.log(`  pane ${r.pane}: ${r.was} → ${r.expected}`);
  }
  for (const m of result.mismatches || []) {
    console.log(`  pane ${m.pane}: has ${m.has}, expected ${m.expected} (left alone)`);
  }
}

async function cmdServe(flags, ctx) {
  // Single-instance guard: the tmux session can outlive the bot (clean exit 0
  // breaks start.sh's loop without tearing the session down). So trust the PID
  // lock, not the session — verify node is alive before bailing out.
  if (await hasSession(ctx, BRIDGE_SESSION)) {
    if (isBridgeAlive()) {
      console.log(`Bridge already running. Stop with 'amux stop', or attach: tmux -S ${ctx.socket} attach -t ${BRIDGE_SESSION}`);
      return;
    }
    console.log("Stale bridge session detected (no live process). Cleaning up...");
    await killSession(ctx, BRIDGE_SESSION);
  }
  if (flags.fg || flags.f) {
    const { spawn } = await import("child_process");
    const child = spawn("bash", ["bin/start.sh"], { cwd: BRIDGE_DIR, stdio: "inherit" });
    return new Promise((res) => child.on("exit", res));
  }
  await ctx.tmux(`new-session -d -s '${esc(BRIDGE_SESSION)}' -c '${esc(BRIDGE_DIR)}' 'bash bin/start.sh'`);
  console.log(`Bridge started (session: ${BRIDGE_SESSION}). Attach: tmux -S ${ctx.socket} attach -t ${BRIDGE_SESSION}`);
}

function isBridgeAlive() {
  const pidfile = process.env.PIDFILE || "/tmp/agentmux.pid";
  try {
    const pid = parseInt(readFileSync(pidfile, "utf-8").trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cmdUnserve(ctx) {
  const hadSession = await hasSession(ctx, BRIDGE_SESSION);
  // Also kill the PID directly: under WSL tmux kill-session sometimes leaves
  // node reparented to init, which then blocks the next `amux serve` via
  // its pidfile lock. Belt + suspenders.
  killBridgeByPid();
  if (hadSession) await killSession(ctx, BRIDGE_SESSION);
  if (!hadSession && !existsSync("/tmp/agentmux.pid")) {
    console.log("Bridge is not running.");
    return;
  }
  console.log("Bridge stopped.");
}

function killBridgeByPid() {
  const pidfile = process.env.PIDFILE || "/tmp/agentmux.pid";
  try {
    const pid = parseInt(readFileSync(pidfile, "utf-8").trim());
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  } catch {}
  try { unlinkSync(pidfile); } catch {}
}

async function cmdStopAll(ctx) {
  const agents = listAgents(ctx.configPath);
  const stopped = [];
  for (const a of agents) {
    if (await hasSession(ctx, a.name)) {
      await killSession(ctx, a.name);
      stopped.push(a.name);
    }
  }
  if (await hasSession(ctx, BRIDGE_SESSION)) {
    await killSession(ctx, BRIDGE_SESSION);
    stopped.push("bridge");
  }
  if (!stopped.length) console.log("Nothing to stop.");
  else console.log(`Stopped: ${stopped.join(", ")}.`);
}

async function cmdSend(name, prompt, flags, ctx) {
  saveLast(ctx.lastFile, name);
  const pane = flags.p || 0;

  // Auto-prepend [from <session>:<window>] when invoker is inside tmux,
  // so receiver panes know which orchestrator briefed them. Invisible
  // when called from raw terminal, Discord bot, or cron (no TMUX env).
  // Opt-out with --no-meta for cases where header is noise (e.g. plain
  // ack pings between panes).
  const exec = (cmd) => execSync(cmd, { encoding: "utf8", timeout: 2000 });
  const sender = flags["no-meta"] ? null : detectSenderFromEnv(process.env, exec);
  const finalPrompt = prependSenderHeader(prompt, sender);

  await sendToPane(ctx, name, pane, finalPrompt);
  if (!flags.q) console.log(`Sent to '${name}' (pane ${pane}): ${truncate(prompt)}`);
}

async function cmdWait(name, flags, ctx) {
  const pane = flags.p || 0;
  const timeout = (flags.t || 300) * 1000;
  const deadline = Date.now() + timeout;
  let sawWorking = false;
  let idleStreak = 0;

  // Quick initial check
  const initStatus = await getPaneStatus(ctx, name, pane);
  if (initStatus === "idle" && !flags.a) {
    console.log("idle");
    return;
  }
  if (initStatus === "working" || initStatus === "resume" || initStatus === "dismiss") {
    sawWorking = true;
  }

  console.log(`Waiting for '${name}' (pane ${pane}) to finish...`);
  while (Date.now() < deadline) {
    const status = await getPaneStatus(ctx, name, pane);

    if (status === "working") { sawWorking = true; idleStreak = 0; }
    else if (status === "menu") {
      if (sawWorking || idleStreak >= 4) { console.log("menu"); process.exit(2); }
    } else if (status === "permission") {
      if (sawWorking || idleStreak >= 4) { console.log("permission"); process.exit(3); }
    } else {
      idleStreak += 2;
      if (sawWorking && idleStreak >= 2) { console.log("ready"); return; }
      if (!sawWorking && idleStreak >= 4) { console.log("idle"); return; }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("timeout");
  process.exit(1);
}

/**
 * Validate an agent name + pane index before we do any work. Rejects
 * shapes like "claw:0" (which look like tmux targets but aren't valid
 * amux agent names) and out-of-bounds panes. Throws user-facing
 * messages so the caller can print them and exit.
 */
export function validateAgentAndPane(ctx, name, pane) {
  if (name.includes(":")) {
    throw new Error(
      `invalid agent name '${name}' — agent names don't contain ':'. ` +
      `Did you mean 'amux ${name.split(":")[0]} -p ${name.split(":")[1] || 0}'?`,
    );
  }
  const config = loadConfig(ctx.configPath);
  if (!config[name]) {
    const known = Object.keys(config).filter((k) => config[k]?.dir).sort();
    throw new Error(
      `unknown agent '${name}'. Known agents: ${known.join(", ") || "(none)"}`,
    );
  }
  const paneCount = getPaneCount(ctx.configPath, name);
  if (pane < 0 || pane >= paneCount) {
    throw new Error(
      `pane ${pane} does not exist. '${name}' has ${paneCount} pane${paneCount === 1 ? "" : "s"} (0-${paneCount - 1}).`,
    );
  }
}

/** Format a set of turns for terminal display. Emoji + separator lines. */
function formatTurnsForDisplay(turns) {
  const out = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const sep = "─".repeat(60);
    const ts = t.timestamp ? ` (${t.timestamp})` : "";
    out.push(sep);
    out.push(`Turn ${i + 1} of ${turns.length}${ts}`);
    out.push(sep);
    out.push(`> ${t.userPrompt.split("\n")[0]}${t.userPrompt.includes("\n") ? " …" : ""}`);
    for (const item of t.items) {
      out.push("");
      if (item.type === "tool") out.push(`  [tool] ${item.content}`);
      else out.push(item.content);
    }
    out.push("");
  }
  return out.join("\n");
}

async function cmdLog(name, flags, ctx) {
  const pane = flags.p || 0;

  try { validateAgentAndPane(ctx, name, pane); }
  catch (err) { console.error(err.message); process.exit(1); }

  if (!(await hasSession(ctx, name))) {
    console.error(`No tmux session for '${name}'. Run 'amux ${name}' to start it.`);
    process.exit(1);
  }

  // --- legacy mode: --text / -t (old default behavior, kept for compat) ---
  if (flags.text || flags.t) {
    const raw = await ctx.agent.capturePane(name, pane, 5000);
    const text = extractText(raw);
    console.log(text || "(empty)");
    return;
  }

  // --- raw tmux capture: --tmux (no filtering, configurable scrollback) ---
  if (flags.tmux && !flags.full && !flags.f) {
    const lines = flags.s || flags.n || 200;
    const raw = await ctx.agent.capturePane(name, pane, lines);
    console.log(raw);
    return;
  }

  // Resolve paneDir for jsonl lookup. Agent-level dir is good enough:
  // Claude Code keys its session store off the cwd it was started in,
  // which for all our panes equals the agent dir.
  const agent = getAgent(ctx.configPath, name);

  // --- full: jsonl history + current tmux state ---
  if (flags.full || flags.f) {
    const since = parseSinceArg(flags.since);
    const grep = flags.grep ? new RegExp(flags.grep, "i") : null;
    const limit = flags.n || 3;
    const jsonl = readLastTurns(agent.dir, { limit, since, grep });
    if (jsonl && jsonl.turns.length) {
      console.log(`═══ jsonl (${jsonl.jsonlFile}) ═══`);
      console.log(formatTurnsForDisplay(jsonl.turns));
    } else {
      console.log(`═══ jsonl: no turns found ═══`);
    }
    const lines = flags.s || 200;
    const raw = await ctx.agent.capturePane(name, pane, lines);
    console.log(`\n═══ tmux (last ${lines} lines) ═══`);
    console.log(raw);
    return;
  }

  // --- default: structured jsonl, last N turns ---
  const since = parseSinceArg(flags.since);
  if (flags.since && !since) {
    console.error(`invalid --since '${flags.since}'. Use ISO or relative ("30min", "2h", "1d").`);
    process.exit(1);
  }
  let grep = null;
  if (flags.grep) {
    try { grep = new RegExp(flags.grep, "i"); }
    catch (err) {
      console.error(`invalid --grep regex: ${err.message}`);
      process.exit(1);
    }
  }
  const limit = flags.n || 3;
  const jsonl = readLastTurns(agent.dir, { limit, since, grep });
  if (!jsonl) {
    console.error(
      `no jsonl found for '${agent.dir}'. ` +
      `Pane may not have run claude yet, or session is in a different cwd. ` +
      `Try --tmux for raw capture.`,
    );
    process.exit(1);
  }
  if (!jsonl.turns.length) {
    const filters = [];
    if (flags.since) filters.push(`--since ${flags.since}`);
    if (flags.grep) filters.push(`--grep '${flags.grep}'`);
    const filterMsg = filters.length ? ` matching ${filters.join(" ")}` : "";
    console.log(`(no turns${filterMsg} in ${jsonl.jsonlFile})`);
    return;
  }
  console.log(formatTurnsForDisplay(jsonl.turns));
}

// --- Timeline / watch: unified cross-pane event view -----------------------

// Role+type → icon mapping. Keep this table close to the formatter so a new
// event category (e.g. "error") is a one-line addition, not a refactor.
const TIMELINE_ICONS = {
  user: "🎤",
  agent: "🤖",
  tool: "🔧",
  error: "⚠️",
};

const TIMELINE_CONTENT_CAP = 80;

/** Compact time string ("HH:MM") for a timeline row; "--:--" if missing. */
function formatTimelineTime(iso) {
  if (!iso) return "--:--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return d.toTimeString().slice(0, 5); // local HH:MM
}

/** Collapse newlines so a multi-line prompt doesn't blow up one row. */
function oneLine(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

/** Map a row's (role, type) to the icon category shown in the stream. */
function timelineCategory(row) {
  if (row.type === "tool") return "tool";
  if (row.type === "error") return "error";
  if (row.role === "user") return "user";
  return "agent";
}

/** Render one event row for the terminal stream. */
function formatTimelineRow(row) {
  const time = formatTimelineTime(row.timestamp);
  const where = `${row.agent}:${row.pane}`.padEnd(12);
  const cat = timelineCategory(row);
  const icon = TIMELINE_ICONS[cat] || "·";
  const label = cat.padEnd(5);
  const content = oneLine(row.content);
  const quoted = cat === "tool" ? content : `"${content}"`;
  const capped = quoted.length > TIMELINE_CONTENT_CAP ? quoted.slice(0, TIMELINE_CONTENT_CAP - 3) + "..." : quoted;
  return `${time}  ${where}  ${icon} ${label}  ${capped}`;
}

/**
 * Pull a snapshot of rows from all configured panes, respecting filters.
 * Validates flags inline so both cmdTimeline and cmdWatch share the parsing.
 */
function collectTimelineRows(ctx, flags, { applyLimit }) {
  const agents = listAgents(ctx.configPath);

  let agentFilter = null;
  if (flags.agent) {
    agentFilter = resolveAgent(flags.agent, ctx.configPath);
    if (!agents.some((a) => a.name === agentFilter)) {
      console.error(`unknown agent '${flags.agent}'. Known: ${agents.map((a) => a.name).join(", ") || "(none)"}`);
      process.exit(1);
    }
  }

  let paneFilter = null;
  if (flags.pane != null) {
    if (!agentFilter) {
      console.error("--pane requires --agent. Which agent's pane should I filter to?");
      process.exit(1);
    }
    const paneCount = getPaneCount(ctx.configPath, agentFilter);
    if (flags.pane < 0 || flags.pane >= paneCount) {
      console.error(`pane ${flags.pane} does not exist. '${agentFilter}' has ${paneCount} pane${paneCount === 1 ? "" : "s"} (0-${paneCount - 1}).`);
      process.exit(1);
    }
    paneFilter = flags.pane;
  }

  let since = null;
  if (flags.since) {
    since = parseSinceArg(flags.since);
    if (!since) {
      console.error(`invalid --since '${flags.since}'. Use ISO or relative ("30min", "2h", "1d").`);
      process.exit(1);
    }
  }

  let grep = null;
  if (flags.grep) {
    try { grep = new RegExp(flags.grep, "i"); }
    catch (err) {
      console.error(`invalid --grep regex: ${err.message}`);
      process.exit(1);
    }
  }

  const limit = applyLimit ? (flags.n || 30) : null;
  return readAllTurnsAcrossPanes({ agents, since, agent: agentFilter, pane: paneFilter, grep, limit });
}

/**
 * Live-tail rows across every pane. Polls the underlying jsonl files once per
 * TIMELINE_POLL_MS and emits rows we haven't printed yet, keyed by
 * (timestamp + agent:pane + content-prefix) to avoid duplicate prints when
 * two events share a millisecond.
 *
 * Deliberately polling (not fs.watch) because fs.watch on WSL and macOS has
 * well-known reliability gaps — missed events are worse than a 1s delay here.
 */
const TIMELINE_POLL_MS = 1000;

async function followTimeline(ctx, flags) {
  const emitted = new Set();
  const rowKey = (r) => `${r.timestamp || ""}|${r.agent}:${r.pane}|${(r.content || "").slice(0, 40)}`;

  // Print the initial snapshot so the viewer has context, then switch to tail-only.
  const initial = collectTimelineRows(ctx, flags, { applyLimit: true });
  for (const r of initial) {
    console.log(formatTimelineRow(r));
    emitted.add(rowKey(r));
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, TIMELINE_POLL_MS));
    const rows = collectTimelineRows(ctx, flags, { applyLimit: false });
    for (const r of rows) {
      const k = rowKey(r);
      if (emitted.has(k)) continue;
      emitted.add(k);
      console.log(formatTimelineRow(r));
    }
  }
}

async function cmdTimeline(ctx, flags) {
  if (flags.follow || flags.f) return followTimeline(ctx, flags);
  const rows = collectTimelineRows(ctx, flags, { applyLimit: true });
  if (!rows.length) {
    console.log("(no events match)");
    return;
  }
  if (flags["by-pane"]) {
    renderTimelineByPane(rows);
    return;
  }
  for (const r of rows) console.log(formatTimelineRow(r));
}

/**
 * Group already-sorted timeline rows under per-pane headers. Each header
 * shows event count + last activity; body retains the standard single-row
 * format so analysis-oriented readers still get chronology within a pane.
 */
function renderTimelineByPane(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.agent}:${r.pane}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  // Sort panes by their latest event ts desc — freshest activity on top.
  const ordered = [...groups.entries()].sort((a, b) => {
    const la = lastTsMs(a[1]);
    const lb = lastTsMs(b[1]);
    return lb - la;
  });

  for (const [key, groupRows] of ordered) {
    const lastTs = lastTsMs(groupRows);
    const lastLabel = lastTs ? new Date(lastTs).toISOString().slice(11, 16) : "??";
    console.log(`\n${key}  (${groupRows.length} event${groupRows.length === 1 ? "" : "s"}, last ${lastLabel})`);
    for (const r of groupRows) console.log("  " + formatTimelineRow(r));
  }
}

function lastTsMs(rows) {
  let max = 0;
  for (const r of rows) {
    if (!r.timestamp) continue;
    const t = Date.parse(r.timestamp);
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

async function cmdWatch(ctx, flags) {
  return followTimeline(ctx, flags);
}

/**
 * "Since last check" view of what panes have done, what's waiting on me,
 * and what's still working. Purpose-built for orchestrator check-ins —
 * answers "who delivered? who needs me? who's still running?" in one call.
 *
 * Anchor resolution: --since <val> overrides; else load checkpoint; else
 * default to 1h ago. Checkpoint is updated to now after a successful read
 * unless --reset is passed (peek mode).
 */
async function cmdDone(ctx, flags) {
  const nowMs = Date.now();
  let sinceMs = null;
  let sinceSource = "";

  if (flags.since) {
    if (flags.since === "last") {
      sinceMs = loadCheckpoint();
      sinceSource = sinceMs ? "last checkpoint" : "1h fallback (no checkpoint)";
    } else {
      const parsed = parseSinceArg(flags.since);
      if (!parsed) {
        console.error(`invalid --since '${flags.since}'. Use "last", ISO, or relative ("30min", "2h").`);
        process.exit(1);
      }
      sinceMs = parsed.getTime();
      sinceSource = `--since ${flags.since}`;
    }
  } else {
    sinceMs = loadCheckpoint();
    sinceSource = sinceMs ? "last checkpoint" : "1h fallback (no checkpoint)";
  }
  if (!sinceMs) sinceMs = nowMs - 60 * 60 * 1000;

  const agents = listAgents(ctx.configPath);
  const rows = readAllTurnsAcrossPanes({ agents, since: new Date(sinceMs) });
  const buckets = groupByPane(rows);

  // Also enumerate panes with ZERO turns so "idle" count stays honest.
  // Each agent in config has a known pane list regardless of jsonl state.
  const allPaneKeys = new Set();
  for (const a of agents) {
    const panes = Array.isArray(a.panes) ? a.panes : [];
    for (let i = 0; i < panes.length; i++) allPaneKeys.add(`${a.name}:${i}`);
  }

  const finished = [];
  const waiting = [];
  const working = [];
  let idleCount = 0;

  for (const key of allPaneKeys) {
    const [agentName, paneStr] = key.split(":");
    const paneIdx = parseInt(paneStr, 10);
    const bucket = buckets.get(key) || {
      agent: agentName, pane: paneIdx, turns: 0,
      latestTurnTs: null, lastUserText: null, lastAssistantText: null,
    };
    const status = await getPaneStatus(ctx, agentName, paneIdx).catch(() => "unknown");
    const cls = classifyPane(bucket, status);

    const entry = { key, bucket, status };
    if (cls === "finished") finished.push(entry);
    else if (cls === "waiting") waiting.push(entry);
    else if (cls === "still-working") working.push(entry);
    else idleCount++;
  }

  // Freshest events first per bucket (within each category).
  const byTsDesc = (a, b) => (b.bucket.latestTurnTs || 0) - (a.bucket.latestTurnTs || 0);
  finished.sort(byTsDesc);
  waiting.sort(byTsDesc);
  working.sort(byTsDesc);

  const sinceIso = new Date(sinceMs).toISOString().slice(0, 16).replace("T", " ");
  const ageMin = Math.round((nowMs - sinceMs) / 60000);
  console.log(`\nSince ${sinceIso} UTC (${ageMin} min ago, source: ${sinceSource})`);

  if (finished.length) {
    console.log(`\n✅ ${finished.length} finished`);
    for (const e of finished) console.log("  " + formatDoneRow(e));
  }
  if (waiting.length) {
    console.log(`\n🔴 ${waiting.length} waiting your input`);
    for (const e of waiting) console.log("  " + formatDoneRow(e));
  }
  if (working.length) {
    console.log(`\n🟡 ${working.length} still working`);
    for (const e of working) console.log("  " + formatDoneRow(e));
  }
  if (!finished.length && !waiting.length && !working.length) {
    console.log(`\n(no activity since cutoff, ${idleCount} panes idle)`);
  } else {
    console.log(`\n💤 ${idleCount} idle (no activity since cutoff)`);
  }

  if (!flags.reset) {
    saveCheckpoint(nowMs);
  } else {
    console.log(`\n(--reset: checkpoint NOT advanced, next 'amux done' will see the same cutoff)`);
  }
}

function formatDoneRow({ key, bucket }) {
  const keyPad = key.padEnd(10);
  const tsLabel = bucket.latestTurnTs
    ? new Date(bucket.latestTurnTs).toISOString().slice(11, 16)
    : "--:--";
  const turnStr = `(+${bucket.turns} turn${bucket.turns === 1 ? "" : "s"})`.padEnd(11);
  const preview = previewText(bucket.lastAssistantText || bucket.lastUserText, 70);
  return `${keyPad}  ${tsLabel}  ${turnStr}  ${preview ? `"${preview}"` : ""}`;
}

// Pane commands that correspond to a dialect we can read context for.
// Bash/other commands get a blank context cell.
const CONTEXT_DIALECT = { claude: "claude", codex: "codex" };

/** Gather status + preview + context for one pane. Safe: never throws. */
async function inspectPane(ctx, agent, pane) {
  const status = await getPaneStatus(ctx, agent.name, pane.index).catch(() => "unknown");
  let content = "";
  try { content = await ctx.agent.capturePane(agent.name, pane.index, 100); }
  catch {}
  const lines = stripAnsi(content).split("\n").filter((l) => l.trim());
  // Claude right-aligns its tail rows with tons of whitespace; collapse it
  // so the preview looks readable when rendered into a left-aligned column.
  const preview = (lines[lines.length - 1] || "").trim();
  const dialect = CONTEXT_DIALECT[pane.command] || null;
  const context = dialect === "claude" ? getContextFromPane(content, agent.dir) : null;
  return { status, preview, context };
}

async function cmdPs(ctx) {
  const agents = listAgents(ctx.configPath);
  let count = 0;

  for (const a of agents) {
    if (!(await hasSession(ctx, a.name))) continue;
    count++;
    const panes = await listPanes(ctx, a.name);

    console.log(`\n● ${a.name.padEnd(12)} ${a.dir}`);
    console.log(`  Panes: ${panes.length}`);

    for (const p of panes) {
      const { status, preview, context } = await inspectPane(ctx, a, p);
      const icon = statusIcon(status);
      const ctxCell = formatContextCell(context);
      const cmd = p.command.padEnd(6);
      // Per-pane `label:` in agents.yaml is a human-set purpose tag
      // (e.g. "agentmux dev", "tandem-tagger deploy"). When present,
      // it replaces the live preview (which is usually just claude's
      // status line) because the label is the info an orchestrator
      // actually needs to pick a pane. Falls back to preview when empty.
      const label = a.panes[p.index]?.label;
      const display = label ? `[${truncate(label, 40)}]` : truncate(preview, 60);
      console.log(`  ${icon} p${p.index}  ${cmd} ${ctxCell}  ${display}`);
    }
  }

  if (count === 0) console.log("No running agents.");
  console.log("\nStatus: 🟢 working  🔴 needs input  💤 idle/done  ⚪ unknown");
}

/**
 * Bulk-compact claude panes above a context-percent threshold.
 *
 * Rationale: a parked claude pane at 80% context costs a full re-read
 * of ~800k tokens on every new turn. /compact summarizes history into
 * working memory and drops token count an order of magnitude, while
 * preserving session intent (unlike /clear which nukes it).
 *
 * Defaults skip panes the user is mid-interaction with: working,
 * permission, menu. --force overrides.
 *
 * Statuses we compact by default: idle, unknown (mostly idle or just-spawned).
 */
const COMPACT_UNSAFE_STATUSES = new Set(["working", "permission", "menu"]);

// Don't bother compacting panes below this absolute token count. Rationale:
// on a 200k-context pane, 20% is only 40k — compacting saves nothing
// meaningful. On a 1M-context pane, 20% is 200k, worth compacting. This
// floor makes the default threshold sensible across both context sizes.
const COMPACT_MIN_TOKENS = 200_000;

async function cmdCompact(ctx, flags = {}, positional = []) {
  const threshold = positional[0] != null ? parseInt(positional[0]) : 20;
  if (Number.isNaN(threshold) || threshold < 0 || threshold > 100) {
    console.error(`Invalid threshold '${positional[0]}'. Must be 0-100.`);
    process.exit(1);
  }
  const minTokens = flags["min-tokens"] != null ? parseInt(flags["min-tokens"]) : COMPACT_MIN_TOKENS;
  const dry = !!flags.dry;
  const force = !!flags.force;

  const agents = listAgents(ctx.configPath);
  const targets = [];
  const skipped = [];

  for (const a of agents) {
    if (!(await hasSession(ctx, a.name))) continue;
    const panes = await listPanes(ctx, a.name);
    for (const p of panes) {
      if (p.command !== "claude") continue;
      const { status, context } = await inspectPane(ctx, a, p);
      if (!context) continue;
      if (context.percent < threshold) continue;
      if (context.tokens < minTokens) continue;
      const unsafe = COMPACT_UNSAFE_STATUSES.has(status);
      if (unsafe && !force) {
        skipped.push({ agent: a.name, pane: p.index, context, status });
        continue;
      }
      targets.push({ agent: a.name, pane: p.index, context, status });
    }
  }

  console.log(`Threshold: ≥${threshold}% and ≥${formatTokens(minTokens)} tokens  |  Action: ${dry ? "dry-run" : "compact"}${force ? "  |  FORCE (will compact working panes)" : ""}`);

  if (targets.length) {
    console.log(`\nCompacting ${targets.length} pane(s):`);
    for (const t of targets) {
      console.log(`  ${t.agent.padEnd(10)} p${t.pane}  ${t.context.percent}%  ${formatTokens(t.context.tokens)}  (${t.status})`);
    }
  }
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length} pane(s) — currently active. Use --force to include:`);
    for (const s of skipped) {
      console.log(`  ${s.agent.padEnd(10)} p${s.pane}  ${s.context.percent}%  ${formatTokens(s.context.tokens)}  (${s.status})`);
    }
  }
  if (!targets.length && !skipped.length) {
    console.log(`\nNo claude panes above ${threshold}%. Nothing to do.`);
    return;
  }

  if (dry || !targets.length) return;

  console.log("");
  for (const t of targets) {
    try {
      // Mirror to Discord with an "amux:compact" source tag so channel
      // watchers can tell this was a bulk-compact action vs a manual
      // /compact somebody typed. Transparency without noise.
      await sendToPane(ctx, t.agent, t.pane, "/compact", { source: "amux:compact" });
      console.log(`✓ ${t.agent} p${t.pane}: /compact sent`);
    } catch (err) {
      console.log(`✗ ${t.agent} p${t.pane}: ${err.message}`);
    }
  }
  console.log(`\nNote: /compact runs asynchronously in each pane. Run 'amux top' in a minute to see new values.`);
}

/**
 * Cross-session context leaderboard. Sorts all claude/codex panes by
 * percent descending (tokens as tie-breaker). Helps answer "which pane
 * is closest to the context ceiling right now?" without manual digging.
 */
async function cmdTop(ctx, flags = {}) {
  const agents = listAgents(ctx.configPath);
  const rows = [];

  for (const a of agents) {
    if (!(await hasSession(ctx, a.name))) continue;
    const panes = await listPanes(ctx, a.name);
    for (const p of panes) {
      if (!CONTEXT_DIALECT[p.command]) continue;
      const { status, preview, context } = await inspectPane(ctx, a, p);
      if (!context) continue;
      const label = a.panes[p.index]?.label || null;
      rows.push({ agent: a.name, pane: p.index, status, context, preview, label });
    }
  }

  if (!rows.length) { console.log("No claude/codex panes with context data."); return; }

  const sortBy = flags.sort === "tokens" ? "tokens" : "percent";
  rows.sort((a, b) => {
    if (sortBy === "tokens") return b.context.tokens - a.context.tokens;
    // Primary: percent desc. Secondary: tokens desc (breaks ties deterministically).
    return (b.context.percent - a.context.percent) || (b.context.tokens - a.context.tokens);
  });

  const n = flags.n || rows.length;
  for (const r of rows.slice(0, n)) {
    const icon = statusIcon(r.status);
    const ctxCell = formatContextCell(r.context);
    const agentCell = r.agent.padEnd(10);
    const paneCell = `p${r.pane}`.padEnd(3);
    const display = r.label ? `[${truncate(r.label, 40)}]` : truncate(r.preview, 50);
    console.log(`  ${icon} ${ctxCell}  ${agentCell} ${paneCell}  ${display}`);
  }
}

// --- Label management -----------------------------------------------------
// Labels live in agentmux.yaml (source) and propagate to agents.yaml
// (generated) via regenerateAgentsYaml. `amux label` and `amux edit`
// read/write the source file; `amux labels` displays current state.

/** Absolute path to the source agentmux.yaml. */
function agentmuxYamlPath(ctx) {
  const dir = ctx.bridgeDir;
  if (!dir) throw new Error("ctx.bridgeDir missing — agent-cli.mjs should set this");
  return join(dir, "agentmux.yaml");
}

/** Read + parse agentmux.yaml. Returns the raw js-yaml object. */
export function loadSourceYaml(ctx) {
  const path = agentmuxYamlPath(ctx);
  if (!existsSync(path)) throw new Error(`agentmux.yaml not found at ${path}`);
  const doc = yaml.load(readFileSync(path, "utf-8"));
  if (!doc || typeof doc !== "object") throw new Error(`agentmux.yaml is empty or malformed at ${path}`);
  return doc;
}

/**
 * Write agentmux.yaml + regenerate agents.yaml in one atomic-ish step.
 *
 * Comments and exact formatting in the original agentmux.yaml are NOT
 * preserved — js-yaml dumps don't round-trip those. For hand-authored
 * files with comments, prefer `amux edit`. This limitation is documented
 * in the `amux label` help text.
 */
export function saveSourceAndRegenerate(ctx, sourceDoc) {
  const srcPath = agentmuxYamlPath(ctx);
  const srcYaml = yaml.dump(sourceDoc, { lineWidth: -1, quotingType: '"' });
  writeFileSync(srcPath, srcYaml);

  // Propagate to agents.yaml using existing channel/id mappings as carry-over.
  const existing = existsSync(ctx.configPath) ? readFileSync(ctx.configPath, "utf-8") : null;
  writeFileSync(ctx.configPath, regenerateAgentsYaml(srcYaml, existing));
}

async function cmdEdit(flags, positional, ctx) {
  // Block `amux edit agents` — agents.yaml is generated, edits there get
  // wiped on next /sync or `amux label`. Point the user to the source.
  if (positional[0] === "agents") {
    console.error("agents.yaml is auto-generated by /sync. Edit agentmux.yaml instead (run 'amux edit').");
    process.exit(1);
  }
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  const path = agentmuxYamlPath(ctx);
  if (!existsSync(path)) {
    console.error(`agentmux.yaml not found at ${path}`);
    process.exit(1);
  }
  // stdio: inherit so the editor takes over the terminal. await the exit.
  const code = await new Promise((done) => {
    const child = spawn(editor, [path], { stdio: "inherit" });
    child.on("exit", (c) => done(c ?? 0));
    child.on("error", (err) => { console.error(`failed to spawn '${editor}': ${err.message}`); done(1); });
  });
  if (code === 0) {
    console.log("saved. run /sync if discord or pane structure changed.");
  }
  process.exit(code);
}

async function cmdLabel(flags, positional, ctx) {
  const [agent, paneStr, ...rest] = positional;
  const text = rest.join(" ").trim();
  if (!agent || paneStr == null) {
    console.error("Usage: amux label <agent> <pane> <text>  (or --clear instead of text)");
    process.exit(1);
  }
  const pane = parseInt(paneStr);
  if (Number.isNaN(pane)) {
    console.error(`invalid pane '${paneStr}' — must be an integer`);
    process.exit(1);
  }

  try { validateAgentAndPane(ctx, agent, pane); }
  catch (err) { console.error(err.message); process.exit(1); }

  if (!flags.clear && !text) {
    console.error("label text required (or use --clear to remove the label)");
    process.exit(1);
  }

  const doc = loadSourceYaml(ctx);
  if (!doc.agents?.[agent]) {
    // Shouldn't happen since validate passed, but guard anyway in case
    // agentmux.yaml and agents.yaml drifted (manual edits).
    console.error(`agent '${agent}' exists in agents.yaml but not in agentmux.yaml — run /sync to re-align`);
    process.exit(1);
  }

  const entry = doc.agents[agent];
  entry.labels = entry.labels || {};

  if (flags.clear) {
    if (!(pane in entry.labels)) {
      console.log(`${agent} p${pane}: no label to clear`);
      return;
    }
    delete entry.labels[pane];
    // KEEP the (possibly empty) labels block. Removing it would drop
    // source authority and let the legacy fallback from existing
    // agents.yaml resurrect old labels on the next regen.
    saveSourceAndRegenerate(ctx, doc);
    console.log(`cleared label on ${agent} p${pane}`);
    return;
  }

  entry.labels[pane] = text;
  saveSourceAndRegenerate(ctx, doc);
  console.log(`${agent} p${pane}: "${text}"`);
}

async function cmdLabels(flags, positional, ctx) {
  const filter = positional[0] || null;
  const doc = loadSourceYaml(ctx);
  if (!doc.agents) {
    console.log("no agents configured in agentmux.yaml");
    return;
  }

  if (filter && !doc.agents[filter]) {
    console.error(`unknown agent '${filter}'. Known: ${Object.keys(doc.agents).sort().join(", ")}`);
    process.exit(1);
  }

  const rows = [];
  const names = Object.keys(doc.agents).sort();
  for (const name of names) {
    if (filter && name !== filter) continue;
    const agentSrc = doc.agents[name];
    // Pane count: agents.yaml is authoritative (services + shells fan out there).
    // Fall back to agentmux.yaml source fields for first-time-never-synced agents.
    let paneCount = getPaneCount(ctx.configPath, name);
    if (paneCount === 0) {
      paneCount = (agentSrc.panes ?? agentSrc.claude ?? 0)
        + (agentSrc.services?.length || 0)
        + (agentSrc.shells ?? 0);
    }
    const labels = agentSrc.labels || {};
    for (let i = 0; i < paneCount; i++) {
      rows.push({ agent: name, pane: i, label: labels[i] || "" });
    }
  }

  if (rows.length === 0) {
    console.log("no panes configured");
    return;
  }

  const w1 = Math.max(...rows.map((r) => r.agent.length), "agent".length);
  console.log(`${"agent".padEnd(w1)}  pane  label`);
  for (const r of rows) {
    const label = r.label || "(no label)";
    console.log(`${r.agent.padEnd(w1)}  ${String(r.pane).padEnd(4)}  ${label}`);
  }
}

async function cmdSelect(name, choice, flags, ctx) {
  const pane = flags.p || 0;
  await selectOption(ctx, name, pane, parseInt(choice));
  console.log(`Selected option ${choice} in '${name}' (pane ${pane}).`);
}

async function cmdEsc(name, flags, ctx) {
  const pane = flags.p || 0;
  await ctx.agent.sendEscape(name, pane);
  console.log(`Sent Escape to '${name}' (pane ${pane}).`);
}

async function cmdAdd(name, dir, ctx) {
  addAgent(ctx.configPath, name, dir);
  console.log(`Added '${name}' → ${dir}`);
}

async function cmdRm(name, ctx) {
  removeAgent(ctx.configPath, name);
  await killSession(ctx, name).catch(() => {});
  console.log(`Removed '${name}'.`);
}

async function cmdResume(ctx) {
  const last = getLast(ctx.lastFile);
  if (!last) { console.error("No recent agent."); process.exit(1); }
  await cmdAttach(last, ctx);
}

function cmdHelp() {
  console.log(`agent - Manage Claude Code tmux sessions

Usage:
  agent                           List agents (● = running)
  agent <name|:nr>                Attach to agent session
  agent <name|:nr> "prompt"       Send prompt to agent
    -n <channel>                  Notify Discord channel when done
    -m <session>                  Message OpenClaw session when done
    -p <pane>                     Target specific pane (default: 0)
    -q                            Quiet (no confirmation output)
  agent add <name> <dir>          Add new agent
  agent rm <name|:nr>             Remove agent
  agent stop <name|:nr>           Stop tmux session (keep config)
  agent reconcile <name|:nr>      Respawn dead service/shell panes to match config
                                  (preserves live claude panes — use instead of stop+start
                                   when only services died)
  agent serve [-f]                Start Discord bridge (daemon). -f = foreground
  agent stop                      Stop Discord bridge (no arg = bridge)
  agent stop --all                Stop bridge + all agent sessions
  agent log <name|:nr> [-n N]     Show agent output (default: last 3 turns from jsonl)
    -n N                          Number of turns (jsonl) or lines (--tmux)
    -p <pane>                     Target pane
    --since T                     jsonl: only turns at/after T (ISO or '30min')
    --grep PAT                    jsonl: only turns matching regex PAT (case-insensitive)
    --tmux [-s N]                 Raw tmux capture, scrollback depth N (default 200)
    --full                        Both jsonl history AND current tmux state
    --text                        [legacy] Filtered tmux extract (pre-jsonl default)
  agent wait <name|:nr> [-t S]    Wait until agent is ready
  agent select <name|:nr> <N>     Select menu option N
  agent esc <name|:nr>            Send Escape (cancel/interrupt)
  agent ps                        Show all running agents + status + context%
  agent top [--sort tokens] [-n N] Cross-session context leaderboard
  agent timeline [-n N]           Cross-pane event stream (kronologisk)
    --since T                     Only events at/after T (ISO or '30min')
    --agent NAME                  Filter to one agent
    --pane N                      Filter to one pane (requires --agent)
    --grep PAT                    Regex filter on content
    --follow, -f                  Live-tail (like tail -f)
  agent watch [--agent] [--pane]  Shortcut for 'timeline --follow'
    [--grep PAT]
  agent edit                      Open agentmux.yaml in $EDITOR (source config)
  agent label <agent> <pane> <text> Set per-pane label (shown in amux ps/top)
    --clear                       Remove the label instead of setting one
                                  (note: rewriting agentmux.yaml via label
                                   may drop comments; use 'amux edit' to preserve)
  agent labels [agent]            Show labels table, optionally filtered to one agent
  agent compact [threshold=20]    Send /compact to claude panes ≥ threshold%
                                  Also requires ≥200k tokens absolute (--min-tokens N to change)
    --dry                         Show what would compact, do nothing
    --force                       Include 'working' panes (default: skip)
  agent r                         Resume last agent
  agent help                      Show this message

Config: ~/.config/agent/agents.yaml
Socket: /tmp/openclaw-claude.sock`);
}

// --- Dispatch ---

const FLAG_SPECS = {
  send: { n: "string", m: "string", p: "number", t: "number", q: "boolean", quiet: "boolean", "no-meta": "boolean" },
  wait: { p: "number", t: "number", a: "boolean" },
  log: {
    n: "number", p: "number",
    full: "boolean", f: "boolean",        // full = jsonl + tmux combined
    text: "boolean", t: "boolean",        // text = legacy filtered tmux extract
    tmux: "boolean",                      // tmux = raw capture, opt-in
    s: "number",                          // scrollback depth for --tmux (default 200)
    since: "string",                      // jsonl: filter by ISO or relative ("30min")
    grep: "string",                       // jsonl: regex filter over prompt + items
  },
  ps: { n: "number" },
  top: { n: "number", sort: "string" },
  timeline: {
    n: "number",
    agent: "string",
    pane: "number",
    since: "string",
    grep: "string",
    follow: "boolean", f: "boolean",
    "by-pane": "boolean",
  },
  done: {
    since: "string",
    reset: "boolean",
  },
  watch: {
    agent: "string",
    pane: "number",
    grep: "string",
  },
  compact: { dry: "boolean", force: "boolean", "min-tokens": "number" },
  label: { clear: "boolean" },
  labels: {},
  edit: {},
  select: { p: "number" },
  esc: { p: "number" },
};

/** Main command dispatch. */
export async function dispatch(argv, ctx) {
  const [cmd, ...rest] = argv;

  switch (cmd) {
    case undefined:
    case "ls":
      return cmdList(ctx);

    case "help":
    case "-h":
    case "--help":
      return cmdHelp();

    case "add": {
      if (rest.length < 2) { console.error("Usage: agent add <name> <dir>"); process.exit(1); }
      return cmdAdd(rest[0], rest[1], ctx);
    }

    case "rm": {
      if (!rest[0]) { console.error("Usage: agent rm <name|:nr>"); process.exit(1); }
      const name = resolveAgent(rest[0], ctx.configPath);
      return cmdRm(name, ctx);
    }

    case "stop": {
      const { flags, positional } = parseFlags(rest, { all: "boolean" });
      // --all → stop bridge + every agent session.
      if (flags.all) return cmdStopAll(ctx);
      // No arg, or 'serve'/'bridge' → stop the bridge (infra daemon).
      if (!positional[0] || positional[0] === "serve" || positional[0] === "bridge") return cmdUnserve(ctx);
      const name = resolveAgent(positional[0], ctx.configPath);
      return cmdStop(name, ctx);
    }

    case "reconcile": {
      if (!rest[0]) { console.error("Usage: agent reconcile <name|:nr>"); process.exit(1); }
      const name = resolveAgent(rest[0], ctx.configPath);
      return cmdReconcile(name, ctx);
    }

    case "serve": {
      const { flags } = parseFlags(rest, { fg: "boolean", f: "boolean" });
      return cmdServe(flags, ctx);
    }

    case "wait": {
      if (!rest[0]) { console.error("Usage: agent wait <name|:nr> [-t S] [-p N]"); process.exit(1); }
      const name = resolveAgent(rest[0], ctx.configPath);
      const { flags } = parseFlags(rest.slice(1), FLAG_SPECS.wait);
      return cmdWait(name, flags, ctx);
    }

    case "log": {
      if (!rest[0]) { console.error("Usage: agent log <name|:nr> [-n N] [-p N]"); process.exit(1); }
      const name = resolveAgent(rest[0], ctx.configPath);
      const { flags } = parseFlags(rest.slice(1), FLAG_SPECS.log);
      return cmdLog(name, flags, ctx);
    }

    case "ps":
      return cmdPs(ctx);

    case "top": {
      const { flags } = parseFlags(rest, FLAG_SPECS.top);
      return cmdTop(ctx, flags);
    }

    case "timeline": {
      const { flags } = parseFlags(rest, FLAG_SPECS.timeline);
      return cmdTimeline(ctx, flags);
    }

    case "watch": {
      const { flags } = parseFlags(rest, FLAG_SPECS.watch);
      return cmdWatch(ctx, flags);
    }

    case "done": {
      const { flags } = parseFlags(rest, FLAG_SPECS.done);
      return cmdDone(ctx, flags);
    }

    case "compact": {
      const { flags, positional } = parseFlags(rest, FLAG_SPECS.compact);
      return cmdCompact(ctx, flags, positional);
    }

    case "edit": {
      const { flags, positional } = parseFlags(rest, FLAG_SPECS.edit);
      return cmdEdit(flags, positional, ctx);
    }

    case "label": {
      const { flags, positional } = parseFlags(rest, FLAG_SPECS.label);
      return cmdLabel(flags, positional, ctx);
    }

    case "labels": {
      const { flags, positional } = parseFlags(rest, FLAG_SPECS.labels);
      return cmdLabels(flags, positional, ctx);
    }

    case "select": {
      if (rest.length < 2) { console.error("Usage: agent select <name|:nr> <N>"); process.exit(1); }
      const name = resolveAgent(rest[0], ctx.configPath);
      const { flags } = parseFlags(rest.slice(2), FLAG_SPECS.select);
      return cmdSelect(name, rest[1], flags, ctx);
    }

    case "esc": {
      if (!rest[0]) { console.error("Usage: agent esc <name|:nr>"); process.exit(1); }
      const name = resolveAgent(rest[0], ctx.configPath);
      const { flags } = parseFlags(rest.slice(1), FLAG_SPECS.esc);
      return cmdEsc(name, flags, ctx);
    }

    case "run": {
      if (rest[0] === "log") {
        const { flags } = parseFlags(rest.slice(1), { n: "number", f: "boolean" });
        return showRunLog(flags.n || 50, flags.f || false);
      }
      if (rest.length < 2) { console.error("Usage: agent run <dir> \"prompt\" [-n channel] [-m session] [-t timeout]"); process.exit(1); }
      const { flags } = parseFlags(rest.slice(2), { n: "string", m: "string", t: "number", fg: "boolean", model: "string" });
      return runOneshot({ dir: rest[0], prompt: rest[1], timeout: flags.t || 600, notifyChannel: flags.n, msgSession: flags.m, model: flags.model, fg: flags.fg ?? false });
    }

    case "plan": {
      if (rest[0] === "log") return showPlanLog();
      if (rest[0] === "status") { console.log("TODO: plan status"); return; }
      if (rest.length < 2 && !rest[0]?.startsWith("-")) { console.error("Usage: agent plan <dir> \"goal\" [-n channel]"); process.exit(1); }
      const dir = rest[0];
      const { flags, positional } = parseFlags(rest.slice(1), { n: "string", m: "string", t: "number", p: "boolean", d: "boolean", fg: "boolean", model: "string" });
      const goal = positional[0] || "";
      if (!goal && !flags.d) { console.error("Usage: agent plan <dir> \"goal\" [-n channel]"); process.exit(1); }
      return executePlan({ dir, goal, timeout: flags.t || 600, notifyChannel: flags.n, msgSession: flags.m, model: flags.model, planOnly: flags.p, dispatchOnly: flags.d, fg: flags.fg ?? false });
    }

    case "events": {
      const { flags } = parseFlags(rest, { n: "number", f: "boolean" });
      console.log(showEvents(undefined, flags.n || 30, flags.f || false));
      return;
    }

    case "r":
    case "resume":
      return cmdResume(ctx);

    // Default: treat first arg as agent name
    default: {
      const name = resolveAgent(cmd, ctx.configPath);
      const { flags, positional } = parseFlags(rest, FLAG_SPECS.send);

      if (positional.length > 0) {
        // Send prompt
        const prompt = positional.join(" ");
        await cmdSend(name, prompt, flags, ctx);

        // Background notification worker (if -n or -m)
        if (flags.n || flags.m) {
          const { notifyWorker } = await import("./notify.mjs");
          const pane = flags.p || 0;
          // Fire and forget - runs until agent is done
          notifyWorker({ name, pane, timeout: flags.t || 600, notifyChannel: flags.n, msgSession: flags.m, prompt, agent: ctx.agent }).catch(() => {});
          console.log(`🔔 Will notify when '${name}' is done.`);
        }
      } else {
        // Attach
        await cmdAttach(name, ctx);
      }
    }
  }
}
