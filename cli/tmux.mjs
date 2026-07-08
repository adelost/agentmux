// Tmux facade for agent CLI. Bridges agent.mjs primitives with CLI-specific operations.
// Stateless: all functions take socket + target explicitly.

import { exec as execCb, execSync, fork } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { createAgent } from "../agent.mjs";
import { esc, stripAnsi } from "../lib.mjs";
import { latestPaneStatesCached, mergeStatus } from "../core/events.mjs";
import { deliverToPane } from "../core/delivery.mjs";
import { detectPaneStatus } from "./format.mjs";
import { findChannelForPane, loadConfig } from "./config.mjs";

const exec = promisify(execCb);

/** Create tmux execution helpers bound to a socket. */
export function createTmuxContext(socket, configPath) {
  const tmuxExec = (cmd) => exec(cmd, { timeout: 5000 });
  const run = (cmd, t = 30000) => exec(cmd, { timeout: t, maxBuffer: 1024 * 1024 });
  const tmux = (cmd) => tmuxExec(`tmux -S '${esc(socket)}' ${cmd}`);

  const agent = createAgent({ tmuxSocket: socket, configPath, timeout: 600000, run, tmuxExec });

  return { tmux, tmuxExec, run, agent, socket, configPath };
}

/** Check if a tmux session exists. */
export async function hasSession(ctx, name) {
  try {
    await ctx.tmux(`has-session -t '${esc(name)}'`);
    return true;
  } catch {
    return false;
  }
}

/** Attach to a tmux session. Must not be called from inside tmux. */
export function attachSession(socket, name) {
  execSync(`tmux -S '${esc(socket)}' attach-session -t '${esc(name)}'`, { stdio: "inherit" });
}

/** Ensure session exists with all panes set up and claude started. */
export async function ensureAndAttach(ctx, name, configPath) {
  const { loadConfig } = await import("./config.mjs");
  const config = loadConfig(configPath);
  const panes = config[name]?.panes || [];
  const agentPanes = panes
    .map((p, i) => (/claude|codex/.test(p?.cmd || "") ? i : -1))
    .filter((i) => i >= 0);

  // Step 1: create session + panes (sequential, once)
  await ctx.agent.ensureReady(name, agentPanes[0] ?? 0);

  const existingPanes = await listPanes(ctx, name);
  const existingCount = existingPanes.length;
  const runnableAgentPanes = existingCount
    ? agentPanes.filter((i) => i < existingCount)
    : agentPanes;
  const missingAgentPanes = existingCount
    ? agentPanes.filter((i) => i >= existingCount)
    : [];
  if (missingAgentPanes.length) {
    console.warn(
      `Only ${existingCount}/${panes.length} panes exist for '${name}'; skipping missing agent panes: ${
        missingAgentPanes.map((i) => `p${i}`).join(", ")
      }`,
    );
  }

  // Step 2: start remaining coding-agent panes in parallel (session already exists)
  if (runnableAgentPanes.length > 1) {
    await Promise.all(runnableAgentPanes.slice(1).map((i) => ctx.agent.ensureReady(name, i)));
  }
}

/** Kill a tmux session. */
export async function killSession(ctx, name) {
  await ctx.tmux(`kill-session -t '${esc(name)}'`);
}

/** List panes in a session. Returns array of { index, command, width, height }. */
export async function listPanes(ctx, name) {
  try {
    const { stdout } = await ctx.tmux(
      `list-panes -t '${esc(name)}' -F '#{pane_index}|#{pane_width}x#{pane_height}|#{pane_current_command}'`,
    );
    return stdout.trim().split("\n").map((line) => {
      const [index, size, command] = line.split("|");
      const [width, height] = size.split("x");
      return { index: parseInt(index), command, width: parseInt(width), height: parseInt(height) };
    });
  } catch {
    return [];
  }
}

/**
 * Get status of a specific pane: tmux scraping refined by hook-pushed
 * events (core/events.mjs). mergeStatus is monotone-safe: pushed events
 * only upgrade idle/unknown, never contradict a live scraped observation
 * (modals, working). ps and auto-compact apply the same merge on their own
 * captures (they reuse a single capture per pane for latency).
 */
export async function getPaneStatus(ctx, name, pane) {
  let stdout;
  try {
    ({ stdout } = await ctx.tmux(
      `capture-pane -t '${esc(name)}:.${pane}' -J -p -S -30`,
    ));
  } catch {
    // Pane/session is GONE. Do not consult pushed events: a dead pane's
    // last event ("prompt" from a turn that will never Stop) would pin it
    // "working" and make wait/dream poll a nonexistent pane to timeout.
    return "unknown";
  }
  const scraped = detectPaneStatus(stripAnsi(stdout));
  const pushed = latestPaneStatesCached().get(`${name}:${pane}`);
  return mergeStatus(scraped, pushed).status;
}

/** Send keys to a pane. */
export async function sendKeys(ctx, name, pane, keys) {
  await ctx.tmux(`send-keys -t '${esc(name)}:.${pane}' ${keys}`);
}

/**
 * Centralized write path to a pane. Every CLI code path that sends text
 * into a claude/codex session should go through here so that:
 *   1. There's one place that handles tmux send-keys (no drift)
 *   2. Discord-bound panes get the same text mirrored automatically
 *      (transparency: Discord = tmux, byte-for-byte)
 *
 * The mirror is best-effort: Discord failures are logged but do NOT
 * roll back the tmux send. tmux is the source of truth; Discord is a
 * projection. If tmux itself fails, the caller sees the exception and
 * the mirror never fires.
 *
 * @param {object} ctx     - tmux context (from createTmuxContext)
 * @param {string} name    - agent name
 * @param {number} pane    - pane index
 * @param {string} text    - exact text to write (including any prefix)
 * @param {object} [opts]
 *   @param {boolean} [opts.mirror=true]   - set false to skip Discord mirror
 *   @param {string}  [opts.source]        - source tag prepended to mirror
 *                                           ("voice" | "orchestrator" | etc).
 *                                           Prefixed ONLY to the mirrored copy
 *                                           so it stays distinguishable from
 *                                           direct user input in the channel.
 *                                           Leave empty to send verbatim.
 */
export async function sendToPane(ctx, name, pane, text, opts = {}) {
  const mirror = opts.mirror !== false;
  const sentAtMs = Date.now();

  // 1. Verified delivery through THE contract (core/delivery.mjs): CLI
  //    briefs used to be fire-and-forget — an agent-to-agent brief could
  //    sit unsubmitted in an idle composer while the sender moved on.
  const result = await deliverToPane(ctx.agent, name, pane, text, {
    log: (m) => console.warn(`send ${name}:${pane}: ${m}`),
  });
  if (!result.delivered) {
    console.error(`⚠ ${name}:${pane} did not acknowledge the message (composer may be stuck — inspect: amux log ${name} -p ${pane} --tmux)`);
  }

  // 2. Best-effort mirror. Failure here is a transparency degradation,
  //    not a correctness issue — the pane already got the text.
  if (!mirror) return;
  if (!ctx.configPath) return;
  const channelId = findChannelForPane(ctx.configPath, name, pane);
  if (!channelId) return;

  const mirrored = opts.source ? `[${opts.source}] ${text}` : text;
  spawnMirrorWorker({ channelId, content: mirrored });
  // Channel topic is intentionally NOT touched here. Topics are a stable
  // per-pane summary set via agentmux.yaml `labels` and propagated by
  // /sync (core/sync-discord.mjs:topicFor). Per-send overwrite was
  // burning Discord's 2-edits-per-10-min cap and clobbering the
  // user's manual focus topic on every brief.

  // 3. Detached forwarder for the agent's reply. Without this, orchestrator
  //    sends (claw:0 → claw:1 etc) are one-way from Discord's perspective:
  //    the brief is mirrored, the response is invisible. The worker polls
  //    jsonl out-of-process so this CLI invocation exits immediately.
  //    Suppress with opts.forwardReply === false (used by handlers etc).
  if (opts.forwardReply === false) return;
  spawnReplyForwarder({
    channelId,
    name,
    pane,
    paneDir: agentPaneDir(ctx.configPath, name, pane),
    briefSnippet: text.slice(0, 80),
    sentAtMs,
  });
}

function agentPaneDir(configPath, name, pane) {
  // Match agent.mjs:paneDir(rootDir, pane) → join(rootDir, '.agents', N)
  try {
    const cfg = loadConfig(configPath);
    const dir = cfg?.[name]?.dir;
    if (!dir) return null;
    return `${dir}/.agents/${pane}`;
  } catch {
    return null;
  }
}

function spawnReplyForwarder(opts) {
  if (!opts.paneDir) return;
  try {
    const workerPath = new URL("./reply-forwarder-worker.mjs", import.meta.url).pathname;
    const worker = fork(workerPath, [], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, REPLY_FWD_OPTS: JSON.stringify(opts) },
    });
    worker.channel?.unref?.();
    worker.unref();
  } catch (err) {
    console.warn(`reply-fwd spawn failed: ${err.message}`);
  }
}

function spawnMirrorWorker(opts) {
  if (!opts.channelId || !opts.content) return;
  try {
    const payloadDir = mkdtempSync(join(tmpdir(), "amux-mirror-"));
    const payloadPath = join(payloadDir, "payload.json");
    writeFileSync(payloadPath, JSON.stringify(opts), "utf-8");
    const workerPath = new URL("./mirror-worker.mjs", import.meta.url).pathname;
    const worker = fork(workerPath, [], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, AMUX_MIRROR_OPTS_FILE: payloadPath },
    });
    worker.channel?.unref?.();
    worker.unref();
  } catch (err) {
    console.warn(`mirror worker spawn failed: ${err.message}`);
  }
}

/** Select a menu option (navigate with arrows + Enter). */
export async function selectOption(ctx, name, pane, choice) {
  const target = `${name}:.${pane}`;
  // Move to top first (20 ups), then down to choice
  for (let i = 0; i < 20; i++) {
    await ctx.tmux(`send-keys -t '${esc(target)}' Up`);
  }
  for (let i = 0; i < choice; i++) {
    await ctx.tmux(`send-keys -t '${esc(target)}' Down`);
  }
  await ctx.tmux(`send-keys -t '${esc(target)}' Enter`);
}
