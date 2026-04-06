// Command dispatch for agent CLI. Routes argv to handlers.
// Intent-driven: each command is a clear function name.

import { loadConfig, listAgents, getAgent, addAgent, removeAgent, resolveAgent, saveLast, getLast, getPaneCount } from "./config.mjs";
import { formatAgentRow, statusIcon, truncate } from "./format.mjs";
import { hasSession, ensureAndAttach, attachSession, killSession, listPanes, getPaneStatus, sendKeys, selectOption, createTmuxContext } from "./tmux.mjs";
import { extractText, extractLastTurn, classifyLines, extractSegments } from "../core/extract.mjs";
import { stripAnsi, extractActivity, formatDuration } from "../lib.mjs";
import { runOneshot, showRunLog } from "./run.mjs";
import { executePlan, showPlanLog } from "./plan.mjs";
import { showEvents } from "./events.mjs";

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
      const status = await getPaneStatus(ctx, a.name, p.index);
      const icon = statusIcon(status);

      // Last line as preview
      try {
        const raw = await ctx.agent.capturePane(a.name, p.index, 5);
        const lines = stripAnsi(raw).split("\n").filter(Boolean);
        const preview = truncate(lines[lines.length - 1] || "", 60);
        console.log(`  ${icon} p${p.index}  (${p.command.padEnd(8)}) ${p.width}x${p.height}  ${preview}`);
      } catch {
        console.log(`  ${icon} p${p.index}  (${p.command})`);
      }
    }
  }

  if (count === 0) console.log("No running agents.");
  console.log("\nStatus: 🟢 working  🔴 needs input  💤 idle/done  ⚪ unknown");
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
  agent log <name|:nr> [-n N]     Show agent output
    --text                        All text blocks, no tool calls
    --full                        Full tmux buffer
    -p <pane>                     Target pane
  agent wait <name|:nr> [-t S]    Wait until agent is ready
  agent select <name|:nr> <N>     Select menu option N
  agent esc <name|:nr>            Send Escape (cancel/interrupt)
  agent ps                        Show all running agents + status
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
      if (!rest[0]) { console.error("Usage: agent stop <name|:nr>"); process.exit(1); }
      const name = resolveAgent(rest[0], ctx.configPath);
      return cmdStop(name, ctx);
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
