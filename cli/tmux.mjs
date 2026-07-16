// Tmux facade for agent CLI. Bridges agent.mjs primitives with CLI-specific operations.
// Stateless: all functions take socket + target explicitly.

import { exec as execCb, execSync, fork } from "child_process";
import { randomUUID } from "crypto";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { createAgent } from "../agent.mjs";
import { esc, stripAnsi } from "../lib.mjs";
import { appendEvent, latestPaneStatesCached, mergeStatus } from "../core/events.mjs";
import {
  CLEARLINE_RECIPE,
  escapeComposerRecipe,
  normalizeComposerKeys,
} from "../core/composer-control.mjs";
import { readParkState, shouldBlockSend, blockedSendMessage } from "../core/pane-park.mjs";
import {
  createDeliveryQueue, DELIVERED_UNVERIFIED_STATE, TERMINAL_DELIVERY_STATES, waitForDeliveryJob,
} from "../core/delivery-queue.mjs";
import { parseSenderHeader } from "../core/sender-detect.mjs";
import { detectPaneStatus } from "./format.mjs";
import { findChannelForPane, validateAgentPane } from "./config.mjs";
import { loadConfig } from "./config.mjs";
import { createNativeRuntimeClient } from "../core/native-runtime-client.mjs";
import { createAgentRouter } from "../core/agent-router.mjs";

const exec = promisify(execCb);

/** Create tmux execution helpers bound to a socket. */
export function createTmuxContext(socket, configPath) {
  const tmuxExec = (cmd) => exec(cmd, { timeout: 5000 });
  const run = (cmd, t = 30000) => exec(cmd, { timeout: t, maxBuffer: 1024 * 1024 });
  const tmux = (cmd) => tmuxExec(`tmux -S '${esc(socket)}' ${cmd}`);

  const tmuxAgent = createAgent({ tmuxSocket: socket, configPath, timeout: 600000, run, tmuxExec });
  const nativeRuntime = createNativeRuntimeClient({ configPath });
  const agent = createAgentRouter({ tmuxAgent, nativeRuntime });

  return {
    tmux,
    tmuxExec,
    run,
    agent,
    tmuxAgent,
    nativeRuntime,
    socket,
    configPath,
    deliveryQueue: createDeliveryQueue({
      validateTarget: (name, pane) => validateAgentPane(configPath, name, pane),
    }),
  };
}

/** Check if a tmux session exists. */
export async function hasSession(ctx, name) {
  if (ctx.agent?.isNativeTarget?.(name, 0)) {
    try { await ctx.agent.nativeRuntime.ensureTarget(name, 0); return true; }
    catch { return false; }
  }
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
  const { loadConfig, getLayout } = await import("./config.mjs");
  const config = loadConfig(configPath);
  const panes = config[name]?.panes || [];
  if (config[name]?.backend === "native") {
    await Promise.all(panes.map((_, pane) => ctx.agent.nativeRuntime.ensureTarget(name, pane)));
    return { native: true, runtimeUrl: config[name].runtimeUrl };
  }
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

  // Step 3: re-apply the configured layout on EVERY `amux <agent>`, not only at
  // creation. A session made before tiled was the default (or manually reshaped
  // into a cramped column) lands back on an even grid where each pane — Codex
  // especially — has the rows it needs to render its composer.
  if (existingCount || runnableAgentPanes.length) {
    const layout = getLayout(configPath, name);
    await ctx.tmux(`select-layout -t '${esc(name)}' '${esc(layout)}'`);
  }
}

/** Kill a tmux session. */
export async function killSession(ctx, name) {
  if (ctx.agent?.isNativeTarget?.(name, 0)) {
    throw new Error(`'${name}' uses the native runtime; stop or delete it from AMUX Code`);
  }
  await ctx.tmux(`kill-session -t '${esc(name)}'`);
}

/** List panes in a session. Returns array of { index, command, width, height }. */
export async function listPanes(ctx, name) {
  if (ctx.agent?.isNativeTarget?.(name, 0)) {
    const entry = loadConfig(ctx.configPath)?.[name];
    if (!entry?.panes) return [];
    return Promise.all(entry.panes.map(async (pane, index) => {
      let command = pane.engine || String(pane.cmd || "").replace(/^native:/, "") || "native";
      try {
        const snapshot = await ctx.agent.nativeRuntime.history(name, index);
        command = `${command}:${snapshot.agent.running ? "working" : "idle"}`;
      } catch {
        command = `${command}:offline`;
      }
      return { index, command, width: 0, height: 0, backend: "native" };
    }));
  }
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
  if (ctx.agent?.isNativeTarget?.(name, pane)) {
    try {
      return (await ctx.agent.nativeRuntime.history(name, pane)).agent.running ? "working" : "idle";
    } catch {
      return "unknown";
    }
  }
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

function validateComposerTarget(ctx, name, pane) {
  if (ctx.configPath) validateAgentPane(ctx.configPath, name, pane);
  if (!Number.isSafeInteger(Number(pane)) || Number(pane) < 0) {
    throw new Error(`Invalid pane '${pane}' for agent '${name}'`);
  }
  if (ctx.agent?.isNativeTarget?.(name, pane)) {
    throw new Error("composer-control is available only for tmux fallback panes");
  }
  if (typeof ctx.tmux !== "function") throw new Error("composer-control requires a tmux context");
}

const actorAddress = (actor) => {
  const match = String(actor || "").match(/^([a-zA-Z0-9_-]+):(\d+)$/u);
  return match ? { session: match[1], pane: Number(match[2]) } : null;
};

async function mirrorComposerControl(ctx, name, pane, receipt, {
  actor = null,
  mirrorDispatch = spawnMirrorWorker,
} = {}) {
  if (!ctx.configPath) return;
  const targetChannel = findChannelForPane(ctx.configPath, name, pane);
  const sender = actorAddress(actor);
  const senderChannel = sender
    ? findChannelForPane(ctx.configPath, sender.session, sender.pane)
    : null;
  const label = receipt.action === "keys"
    ? `keys ${receipt.keys.join(" ")}`
    : receipt.action === "esc-pager" ? "esc (pager exit)" : receipt.action;
  const command = receipt.action === "keys"
    ? `amux keys ${name} -p ${pane} ${receipt.keys.join(" ")}`
    : `amux ${receipt.action === "esc-pager" ? "esc" : receipt.action} ${name} -p ${pane}`;
  try {
    if (targetChannel) {
      await mirrorDispatch({
        channelId: targetChannel,
        content: `[composer-control${actor ? ` from ${actor}` : ""}] ${label} (${receipt.controlId})`,
      });
    }
    if (senderChannel && senderChannel !== targetChannel) {
      await mirrorDispatch({
        channelId: senderChannel,
        content: `\`${command}\` → sent (${receipt.controlId})`,
      });
    }
  } catch (error) {
    console.warn(`composer-control mirror failed: ${error.message}`);
  }
}

async function sendComposerControl(ctx, name, pane, keys, {
  action,
  actor = null,
  controlId = randomUUID(),
  now = () => new Date(),
  record = appendEvent,
  mirrorDispatch = spawnMirrorWorker,
} = {}) {
  validateComposerTarget(ctx, name, pane);
  const keyList = Object.freeze([...keys]);
  const event = (state, detail = "") => ({
    ts: now().toISOString(),
    event: `composer_control_${state}`,
    session: name,
    pane: Number(pane),
    controlId,
    action,
    keys: keyList,
    actor,
    detail,
  });

  // Durable intent precedes the physical write. A crash after tmux accepts
  // the keys therefore remains an explicit ambiguous request, never an
  // invisible mutation that automation can safely assume did not happen.
  record(event("requested"));
  try {
    await ctx.tmux(`send-keys -t '${esc(name)}:.${Number(pane)}' ${keyList.join(" ")}`);
  } catch (error) {
    try { record(event("failed", String(error.message || error).slice(0, 200))); }
    catch { /* requested is the durable provenance floor */ }
    throw error;
  }

  const receipt = Object.freeze({
    controlId,
    action,
    keys: keyList,
    target: `${name}:${Number(pane)}`,
  });
  let receiptError = null;
  try { record(event("sent")); }
  catch (error) { receiptError = error; }
  await mirrorComposerControl(ctx, name, Number(pane), receipt, { actor, mirrorDispatch });
  if (receiptError) {
    // The requested row is already durable and the physical write cannot be
    // rolled back. Fail-loud without suggesting that retry is safe.
    throw new Error(
      `composer-control ${controlId} was sent but its receipt failed; do not retry: ${receiptError.message}`,
    );
  }
  return receipt;
}

/** Public allowlisted key primitive used by `amux keys` and `amux enter`. */
export async function sendComposerKeys(ctx, name, pane, keys, options = {}) {
  return sendComposerControl(ctx, name, pane, normalizeComposerKeys(keys), {
    ...options,
    action: options.action || "keys",
  });
}

/** Exact explicit clear recipe; C-u is intentionally not part of it. */
export async function clearPaneComposer(ctx, name, pane, options = {}) {
  return sendComposerControl(ctx, name, pane, CLEARLINE_RECIPE, {
    ...options,
    action: "clearline",
  });
}

/** Escape a normal pane, or close a verified Codex pager with internal `q`. */
export async function escapePaneComposer(ctx, name, pane, options = {}) {
  validateComposerTarget(ctx, name, pane);
  let snapshot = "";
  try { snapshot = await ctx.agent.captureScreen(name, pane); }
  catch { /* retain historical Escape behavior when capture is unavailable */ }
  const recipe = escapeComposerRecipe(snapshot);
  const receipt = await sendComposerControl(ctx, name, pane, recipe.keys, {
    ...options,
    action: recipe.pager ? "esc-pager" : "esc",
  });
  return Object.freeze({ ...receipt, pager: recipe.pager });
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
  // Validate before the durable write. A typo such as `amux queue ...`
  // previously became an immortal target named "queue" and the broker
  // retried it forever even though that session never existed.
  if (ctx.configPath) validateAgentPane(ctx.configPath, name, pane);
  const mirror = opts.mirror !== false;
  const mirrorDispatch = opts.mirrorDispatch || spawnMirrorWorker;
  const sender = parseSenderHeader(text);
  const targetChannelId = ctx.configPath
    ? findChannelForPane(ctx.configPath, name, pane)
    : null;
  const senderChannelId = ctx.configPath && sender
    ? findChannelForPane(ctx.configPath, sender.session, sender.pane)
    : null;
  const senderPayload = sender
    ? String(text).replace(/^\[from [a-zA-Z0-9_-]+:\d+\](?:\r?\n)*/u, "").trimStart()
    : String(text).trimStart();
  if (sender && !senderPayload.startsWith("/")
    && (!opts.premiseStamp || opts.premiseStamp.schemaVersion !== 1
      || opts.premiseStamp.producer !== "amux.premise-proof.v1"
      || !/^sha256:[a-f0-9]{64}$/u.test(String(opts.premiseStamp.attestationHash || "")))) {
    throw new Error("inter-agent brief requires a tool-generated amux.premise-proof.v1 attestation");
  }

  const mirrorSenderStatus = (result) => {
    if (!mirror || !sender || sender.key === `${name}:${pane}` || !ctx.configPath) return;
    if (!senderChannelId) return;
    const status = result?.unverified
      ? "delivery unverified"
      : result?.delivered
      ? "delivered"
      : result?.pending
      ? "durably queued; NOT delivered"
      : "NOT delivered";
    mirrorDispatch({ channelId: senderChannelId, content: `\`amux ${name} -p ${pane} …\` → ${status}.` });
  };

  // 0. Park guard: a pane parked by model-watch (model downgrade) must not
  //    be woken by a brief — the work would run on the fallback model
  //    (api:3, 2026-07-10). Slash commands (administration, incl. the
  //    /model recovery) pass; opts.force is the explicit override.
  //    Fail-loud: the sender sees WHY, and the bound channel gets the same
  //    line so dropped briefs are never invisible.
  const park = opts.force ? null : readParkState(name, pane);
  if (shouldBlockSend({ text, park, force: opts.force })) {
    const notice = blockedSendMessage(`${name}:${pane}`, park);
    console.error(notice);
    if (mirror && ctx.configPath) {
      const channelId = findChannelForPane(ctx.configPath, name, pane);
      if (channelId) spawnMirrorWorker({ channelId, content: `[park-guard] ${notice}` });
    }
    return { delivered: false, blocked: true };
  }

  // 1. Persist first. The bridge broker is the sole normal tmux writer and
  // drains this per-pane FIFO. Separate `amux` processes therefore cannot
  // concatenate their paste blocks in one composer. If the bridge is stopped,
  // the command remains safely queued for its next start.
  const queue = ctx.deliveryQueue || createDeliveryQueue({
    validateTarget: ctx.configPath
      ? (targetName, targetPane) => validateAgentPane(ctx.configPath, targetName, targetPane)
      : null,
  });
  const job = queue.enqueue({
    agentName: name,
    pane,
    text,
    source: opts.source || "cli",
    metadata: { sender: sender?.key || null, channelId: targetChannelId, senderChannelId,
      ...(opts.premiseStamp ? { premiseStamp: opts.premiseStamp } : {}) },
    idempotencyKey: opts.idempotencyKey || null,
  });
  const settled = await waitForDeliveryJob(queue, job.id, {
    timeoutMs: opts.waitMs ?? ctx.deliveryWaitMs ?? 12_000,
  });
  const acknowledged = settled?.status === "acknowledged";
  const cancelled = settled?.status === "cancelled";
  const queueState = settled?.status || job.status;
  const outcome = {
    accepted: true,
    delivered: acknowledged,
    blocked: cancelled,
    pending: !TERMINAL_DELIVERY_STATES.has(queueState),
    unverified: queueState === DELIVERED_UNVERIFIED_STATE,
    via: acknowledged ? "broker" : "broker-queue",
    jobId: job.id,
    queueState,
    ...(cancelled ? { reason: settled.lastReason } : {}),
  };

  // 2. Best-effort mirror. Failure here is a transparency degradation,
  //    not a correctness issue — the pane already got the text.
  if (!outcome.delivered) {
    mirrorSenderStatus(outcome);
    return outcome;
  }
  if (!mirror) return outcome;
  if (!ctx.configPath) return outcome;
  if (targetChannelId) {
    const mirrored = opts.source ? `[${opts.source}] ${text}` : text;
    mirrorDispatch({ channelId: targetChannelId, content: mirrored });
  }
  mirrorSenderStatus(outcome);
  // Channel topic is intentionally NOT touched here. Topics are a stable
  // per-pane summary set via agentmux.yaml `labels` and propagated by
  // /sync (core/sync-discord.mjs:topicFor). Per-send overwrite was
  // burning Discord's 2-edits-per-10-min cap and clobbering the
  // user's manual focus topic on every brief.

  // Replies have one owner: channels/jsonl-watcher.mjs. A second detached
  // forwarder raced that watcher and produced A,B,A,C,B,C duplicate posts
  // for inter-agent briefs. The watcher already covers every bound pane and
  // persists its dedupe state across bridge restarts.
  return outcome;
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
  if (!Number.isInteger(choice) || choice < 1) {
    throw new Error(`menu option must be a 1-based positive integer (got ${choice})`);
  }
  const target = `${name}:.${pane}`;
  // Move to top first (20 ups), then down to choice
  for (let i = 0; i < 20; i++) {
    await ctx.tmux(`send-keys -t '${esc(target)}' Up`);
  }
  // The CLI and Claude menus label options from 1. Choice 1 is already at
  // the top after the Up sweep, so only choice-1 Down presses are needed.
  for (let i = 1; i < choice; i++) {
    await ctx.tmux(`send-keys -t '${esc(target)}' Down`);
  }
  await ctx.tmux(`send-keys -t '${esc(target)}' Enter`);
}
