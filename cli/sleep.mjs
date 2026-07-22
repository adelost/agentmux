// `amux sleep`, `amux wake`, and the conservative T8/T10 candidate sweep.
// Claude is the only V1 engine because it exposes exact slash, compact-boundary,
// prompt, response, and exact-session receipts. Codex and Kimi fail closed.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import https from "node:https";
import { listAgents } from "./config.mjs";
import {
  agentEntry,
  exactResponse,
  observePane,
  paneDefinition,
  paneDirectory,
  poll,
} from "./sleep-probes.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { sendSlashVerified } from "../core/delivery.mjs";
import { hasClaudeCompactBoundaryAfterSubmit } from "../core/claude-submit-boundary.mjs";
import { latestClaudeSessionIdentity } from "../core/native-session-identity.mjs";
import { createWakeAdmissionGate } from "../core/wake-admission.mjs";
import {
  beginSleepState,
  blockedSleepState,
  compactReceiptOk,
  cursorHash,
  findSleepCandidates,
  hasClaudeUserActivityAfterCursor,
  paneSleepStateDir,
  planSleepRollup,
  readPaneSleepState,
  rollupKey,
  sleepingWakeDecision,
  writePaneSleepState,
} from "../core/pane-sleep.mjs";

const ROLLUP_THROTTLE_MS = 30 * 60 * 1000;
const MAX_SLEEPS_PER_SWEEP = 2;
const SHELL_COMMAND = /^(?:bash|zsh|sh|fish|dash)$/u;

/** WHAT: Stores exact compact proof before exiting one idle Claude pane. WHY: Keeps delivery, identity, and shutdown serialized. */
export async function cmdSleep(ctx, agentName, pane, _opts = {}, deps = {}) {
  const queue = deps.queue || ctx.deliveryQueue || createDeliveryQueue();
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((done) => setTimeout(done, ms)));
  const exec = deps.exec || execFileSync;
  const readFile = deps.readFile || readFileSync;
  const exit = deps.exit || ((code) => { process.exitCode = code; });
  const observe = deps.observe || observePane;
  const latestIdentity = deps.latestIdentity || latestClaudeSessionIdentity;
  const sendSlash = deps.sendSlash || sendSlashVerified;
  const hasCompactBoundary = deps.hasCompactBoundary || hasClaudeCompactBoundaryAfterSubmit;
  const hasActivityAfterCursor = deps.hasActivityAfterCursor || hasClaudeUserActivityAfterCursor;
  const stateOptions = { rootDir: deps.stateRoot || paneSleepStateDir() };
  const agent = agentEntry(ctx, agentName, deps.agents);
  if (!agent || !paneDefinition(agent, pane)) {
    console.error(`unknown-pane:${agentName}:${pane}`);
    return exit(1);
  }

  const lease = queue.acquireSessionLease?.(agentName);
  if (!lease) {
    console.error("sleep-lease-busy");
    return exit(1);
  }
  let state = null;
  const fail = (reason) => {
    if (state) {
      state = writePaneSleepState(blockedSleepState(state, reason, now()), stateOptions);
    }
    console.error(reason);
    exit(1);
  };

  try {
    const previous = readPaneSleepState(agentName, pane, stateOptions);
    if (previous && previous.status !== "awake" && previous.status !== "blocked") {
      return fail(`sleep-state-${previous.status}`);
    }
    const first = await observe(ctx, agent, pane, {
      exec, queue, readFile, requireIdle: deps.requireIdle !== false, nowMs: now(),
    });
    if (!first.ok) return fail(first.reason);
    state = beginSleepState({
      previous,
      agentName,
      pane,
      sessionId: first.identity?.sessionId,
      processGeneration: first.processGeneration,
      nowMs: now(),
    });
    writePaneSleepState(state, stateOptions);

    const compactFence = await ctx.agent.capturePromptEchoCursor(
      agentName, pane, `AMUX-COMPACT-FENCE-${state.sleepGeneration}`,
    ).catch(() => null);
    if (!compactFence || !Object.keys(compactFence.positions || {}).length) {
      return fail("compact-cursor-missing");
    }
    const compactSubmittedAt = now();
    const compact = await sendSlash(ctx.agent, agentName, pane, "/compact", {
      suppressReceipt: true,
      settleMs: deps.slashSettleMs ?? 200,
      maxRescues: 2,
      sleep,
    });
    if (!compact.delivered || compact.via !== "command-receipt") {
      return fail("compact-command-unverified");
    }
    const boundary = await poll(
      deps.compactPollAttempts ?? 120,
      deps.compactPollMs ?? 1_000,
      sleep,
      () => hasCompactBoundary(compactFence, compactSubmittedAt),
    );
    if (!boundary) return fail("compact-boundary-missing");

    const postCompactIdentity = latestIdentity(paneDirectory(agent, pane));
    if (!postCompactIdentity?.sessionId) return fail("post-compact-session-missing");
    state = {
      ...state,
      stage: "post-compact-check",
      sessionId: postCompactIdentity.sessionId,
      compactCursorHash: cursorHash(compactFence),
      updatedAt: now(),
    };
    writePaneSleepState(state, stateOptions);

    const nonce = (deps.uuid || randomUUID)().replaceAll("-", "").slice(0, 16);
    const expectedResponse = `AMUX_SLEEP_CHECK_${nonce}_OK`;
    const prompt = `[AMUX-SLEEP-CHECK ${nonce}] Reply with exactly ${expectedResponse} and nothing else.`;
    const promptCursor = await ctx.agent.capturePromptEchoCursor(agentName, pane, prompt).catch(() => null);
    if (!promptCursor) return fail("sleep-check-cursor-missing");
    await ctx.agent.sendOnly(agentName, prompt, pane);
    const echoed = await ctx.agent.waitForPromptEcho(
      agentName,
      pane,
      prompt,
      deps.promptEchoTimeoutMs ?? 15_000,
      { cursor: promptCursor },
    ).catch(() => false);
    if (!echoed) return fail("sleep-check-prompt-unverified");
    const responded = await poll(
      deps.responsePollAttempts ?? 120,
      deps.responsePollMs ?? 1_000,
      sleep,
      async () => {
        if (await ctx.agent.isBusy(agentName, pane).catch(() => true)) return false;
        const result = await ctx.agent.getResponseStreamWithRaw(agentName, pane, prompt).catch(() => null);
        return exactResponse(result) === expectedResponse;
      },
    );
    if (!responded) return fail("sleep-check-response-missing");

    const quietCursor = await ctx.agent.capturePromptEchoCursor(
      agentName, pane, `AMUX-QUIET-FENCE-${nonce}`,
    ).catch(() => null);
    if (!quietCursor) return fail("quiet-cursor-missing");
    const firstIdle = await observe(ctx, agent, pane, {
      exec, queue, readFile, requireIdle: false, nowMs: now(),
      expectedProcessGeneration: first.processGeneration,
      expectedSessionId: postCompactIdentity.sessionId,
    });
    if (!firstIdle.ok) return fail(`post-check-1:${firstIdle.reason}`);
    await sleep(deps.observationGapMs ?? 2_000);
    const secondIdle = await observe(ctx, agent, pane, {
      exec, queue, readFile, requireIdle: false, nowMs: now(),
      expectedProcessGeneration: first.processGeneration,
      expectedSessionId: postCompactIdentity.sessionId,
    });
    if (!secondIdle.ok) return fail(`post-check-2:${secondIdle.reason}`);
    if (hasActivityAfterCursor(quietCursor)) return fail("activity-after-sleep-check");

    const receipt = {
      version: 1,
      engine: "claude",
      sleepGeneration: state.sleepGeneration,
      sessionId: postCompactIdentity.sessionId,
      compactBoundary: true,
      compactCursorHash: cursorHash(compactFence),
      nonce,
      response: expectedResponse,
      observations: 2,
      noActivityAfterCheck: true,
    };
    if (!compactReceiptOk(receipt)) return fail("sleep-receipt-invalid");
    state = {
      ...state,
      stage: "exit-intent",
      receipt,
      updatedAt: now(),
    };
    writePaneSleepState(state, stateOptions);

    const stopped = await sendSlash(ctx.agent, agentName, pane, "/exit", {
      suppressReceipt: true,
      settleMs: deps.slashSettleMs ?? 200,
      maxRescues: 1,
      sleep,
    });
    if (!stopped.delivered || stopped.via !== "command-receipt") {
      return fail("graceful-exit-unverified");
    }
    const shellReady = await poll(
      deps.shellPollAttempts ?? 60,
      deps.shellPollMs ?? 500,
      sleep,
      async () => {
        const processState = await ctx.agent.paneProcessState(agentName, pane).catch(() => null);
        return processState?.shell === true && SHELL_COMMAND.test(processState.command || "");
      },
    );
    if (!shellReady) return fail("sleep-shell-unverified");

    state = writePaneSleepState({
      ...state,
      status: "asleep",
      stage: "asleep",
      sleptAt: now(),
      updatedAt: now(),
    }, stateOptions);
    console.log(`SLEPT ${agentName}:${pane} generation=${state.sleepGeneration}`);
    return state;
  } catch (error) {
    return fail(`sleep-error:${error.message}`);
  } finally {
    lease.release();
  }
}

/** WHAT: Routes wake to the exact recorded session. WHY: Keeps stale sleep state from spawning a replacement session. */
export async function cmdWake(ctx, agentName, pane, { force = false } = {}, deps = {}) {
  const queue = deps.queue || ctx.deliveryQueue || createDeliveryQueue();
  const exit = deps.exit || ((code) => { process.exitCode = code; });
  const now = deps.now || (() => Date.now());
  const gate = deps.gate || createWakeAdmissionGate({ runtimeRoot: ctx.bridgeDir, reserveMiB: 512 });
  const latestIdentity = deps.latestIdentity || latestClaudeSessionIdentity;
  const stateOptions = { rootDir: deps.stateRoot || paneSleepStateDir() };
  const agent = agentEntry(ctx, agentName, deps.agents);
  if (!agent || !paneDefinition(agent, pane)) {
    console.error(`unknown-pane:${agentName}:${pane}`);
    return exit(1);
  }
  const lease = queue.acquireSessionLease?.(agentName);
  if (!lease) {
    console.error("wake-lease-busy");
    return exit(1);
  }
  try {
    const verdict = await gate({ agentName, pane });
    if (!force && !verdict?.ok) {
      console.error(`wake-refused:${verdict?.reason || "unknown"}`);
      return exit(1);
    }
    let state = readPaneSleepState(agentName, pane, stateOptions);
    const identity = latestIdentity(paneDirectory(agent, pane));
    const decision = sleepingWakeDecision({ state, sessionId: identity?.sessionId || null });
    if (!decision.ok) {
      console.error(`wake-refused:${decision.reason}`);
      return exit(1);
    }
    if (decision.tracked) {
      state = writePaneSleepState({
        ...state,
        status: "wake_pending",
        stage: "wake-intent",
        wakeRequestedAt: state.wakeRequestedAt || now(),
        updatedAt: now(),
      }, stateOptions);
    }
    await ctx.agent.ensureReady(agentName, pane);
    const processState = await ctx.agent.paneProcessState(agentName, pane).catch(() => null);
    const resumed = latestIdentity(paneDirectory(agent, pane));
    if (processState?.running !== true
        || (decision.tracked && resumed?.sessionId !== state.sessionId)) {
      if (state) writePaneSleepState(blockedSleepState(state, "wake-verification-failed", now()), stateOptions);
      console.error("wake-verification-failed");
      return exit(1);
    }
    if (state) {
      writePaneSleepState({
        ...state,
        status: "awake",
        stage: "awake",
        wokeAt: now(),
        updatedAt: now(),
      }, stateOptions);
    }
    console.log(`WAKE ${agentName}:${pane}${decision.tracked ? ` generation=${state.sleepGeneration}` : ""}`);
    return undefined;
  } finally {
    lease.release();
  }
}

function readRollupState(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

function writeRollupState(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function postDiscord(channelId, content, token) {
  const body = JSON.stringify({ content });
  return new Promise((resolvePromise, reject) => {
    const request = https.request({
      method: "POST",
      hostname: "discord.com",
      path: `/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
      headers: {
        authorization: `Bot ${token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      response.resume();
      response.on("end", () => response.statusCode >= 200 && response.statusCode < 300
        ? resolvePromise()
        : reject(new Error(`Discord status ${response.statusCode}`)));
    });
    request.on("error", reject);
    request.end(body);
  });
}

/** Scan read-only by default; `--apply` sleeps at most two candidates and re-runs every gate. */
/** WHAT: Schedules bounded sleep candidates. WHY: Keeps fleet maintenance conservative and rate-limited. */
export async function cmdSleepWatch(ctx, {
  once = true,
  dry = false,
  apply = false,
} = {}, deps = {}) {
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((done) => setTimeout(done, ms)));
  const exec = deps.exec || execFileSync;
  const queue = deps.queue || ctx.deliveryQueue || createDeliveryQueue();
  const agents = deps.agents || listAgents(ctx.configPath);
  const statePath = deps.statePath || join(homedir(), ".agentmux", "sleep-watch.json");
  const log = deps.log || ((line) => console.log(line));
  const env = deps.env || process.env;
  const observe = deps.observe || observePane;

  for (;;) {
    const observedAt = now();
    const rows = [];
    for (const agent of agents) {
      for (let pane = 0; pane < (agent.panes || []).length; pane += 1) {
        const observation = await observe(ctx, agent, pane, {
          exec,
          queue,
          readFile: deps.readFile || readFileSync,
          requireIdle: true,
          nowMs: observedAt,
        });
        rows.push({
          key: `${agent.name}:${pane}`,
          agentName: agent.name,
          pane,
          ...observation.facts,
          lastActivityMs: observation.lastActivityMs,
          processGeneration: observation.processGeneration,
        });
      }
    }
    const candidates = findSleepCandidates({ panes: rows, nowMs: observedAt });
    const stuck = rows
      .filter((row) => row.busy === true
        && Number.isFinite(row.lastActivityMs)
        && observedAt - row.lastActivityMs >= 48 * 60 * 60 * 1000)
      .map((row) => ({
        key: row.key,
        processGeneration: row.processGeneration,
        evidence: "busy with no journal activity for at least 48h",
      }));
    const rollup = planSleepRollup({ candidates, stuck });

    if (dry) {
      log(rollup);
    } else {
      if (apply) {
        for (const candidate of candidates.slice(0, MAX_SLEEPS_PER_SWEEP)) {
          const row = rows.find((value) => value.key === candidate.key);
          await cmdSleep(ctx, row.agentName, row.pane, {}, {
            ...deps,
            agents,
            queue,
            requireIdle: true,
          });
        }
      }
      const key = rollupKey(candidates, stuck);
      const prior = readRollupState(statePath);
      const changed = prior?.rollupKey !== key;
      const throttled = observedAt - Number(prior?.lastRollupAt || 0) <= ROLLUP_THROTTLE_MS;
      if (changed && !throttled) {
        if (env.AMUX_MANAGER_CHANNEL && env.DISCORD_TOKEN) {
          await (deps.post || postDiscord)(env.AMUX_MANAGER_CHANNEL, rollup, env.DISCORD_TOKEN);
        } else {
          log(rollup);
        }
        writeRollupState(statePath, { rollupKey: key, lastRollupAt: observedAt });
      }
    }
    if (once) return;
    await sleep(deps.intervalMs ?? 5 * 60 * 1000);
  }
}
