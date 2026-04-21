// Command dispatch for agent CLI. Routes argv to handlers.
// Intent-driven: each command is a clear function name.

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync, existsSync, unlinkSync } from "fs";
import { loadConfig, listAgents, getAgent, addAgent, removeAgent, resolveAgent, saveLast, getLast, getPaneCount } from "./config.mjs";
import { formatAgentRow, statusIcon, truncate, formatContextCell, formatTokens } from "./format.mjs";
import { hasSession, ensureAndAttach, attachSession, killSession, listPanes, getPaneStatus, sendKeys, selectOption, createTmuxContext } from "./tmux.mjs";
import { extractText, extractLastTurn, classifyLines, extractSegments } from "../core/extract.mjs";
import { stripAnsi, esc, extractActivity, formatDuration } from "../lib.mjs";
import { getContextFromPane } from "../core/context.mjs";
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
  await ctx.agent.sendOnly(name, prompt, pane);
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

async function cmdLog(name, flags, ctx) {
  const pane = flags.p || 0;
  const lines = flags.n || null;
  const full = flags.full || flags.f || false;
  const textOnly = flags.text || flags.t || false;

  if (!(await hasSession(ctx, name))) {
    console.error(`No tmux session for '${name}'.`);
    process.exit(1);
  }

  if (textOnly) {
    const raw = await ctx.agent.capturePane(name, pane, 5000);
    const text = extractText(raw);
    console.log(text || "(empty)");
  } else if (full) {
    const raw = await ctx.agent.capturePane(name, pane, 5000);
    console.log(raw);
  } else if (lines) {
    const raw = await ctx.agent.capturePane(name, pane, lines);
    console.log(raw);
  } else {
    const text = await ctx.agent.getResponse(name, pane);
    console.log(text);
  }
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
      console.log(`  ${icon} p${p.index}  ${cmd} ${ctxCell}  ${truncate(preview, 60)}`);
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
      const target = `${t.agent}:.${t.pane}`;
      await ctx.tmux(`send-keys -t '${esc(target)}' -l -- '/compact'`);
      await ctx.tmux(`send-keys -t '${esc(target)}' Enter`);
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
      rows.push({ agent: a.name, pane: p.index, status, context, preview });
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
    console.log(`  ${icon} ${ctxCell}  ${agentCell} ${paneCell}  ${truncate(r.preview, 50)}`);
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
  agent serve [-f]                Start Discord bridge (daemon). -f = foreground
  agent stop                      Stop Discord bridge (no arg = bridge)
  agent stop --all                Stop bridge + all agent sessions
  agent log <name|:nr> [-n N]     Show agent output
    --text                        All text blocks, no tool calls
    --full                        Full tmux buffer
    -p <pane>                     Target pane
  agent wait <name|:nr> [-t S]    Wait until agent is ready
  agent select <name|:nr> <N>     Select menu option N
  agent esc <name|:nr>            Send Escape (cancel/interrupt)
  agent ps                        Show all running agents + status + context%
  agent top [--sort tokens] [-n N] Cross-session context leaderboard
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
  send: { n: "string", m: "string", p: "number", t: "number", q: "boolean", quiet: "boolean" },
  wait: { p: "number", t: "number", a: "boolean" },
  log: { n: "number", p: "number", full: "boolean", f: "boolean", text: "boolean", t: "boolean" },
  ps: { n: "number" },
  top: { n: "number", sort: "string" },
  compact: { dry: "boolean", force: "boolean", "min-tokens": "number" },
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

    case "compact": {
      const { flags, positional } = parseFlags(rest, FLAG_SPECS.compact);
      return cmdCompact(ctx, flags, positional);
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
