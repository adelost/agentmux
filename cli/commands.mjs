// Command dispatch for agent CLI. Routes argv to handlers.
// Intent-driven: each command is a clear function name.

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { loadConfig, listAgents, getAgent, addAgent, removeAgent, resolveAgent, saveLast, getLast, getPaneCount, findChannelForPane } from "./config.mjs";
import { formatAgentRow, statusIcon, truncate, formatContextCell, formatTokens, detectPaneStatus } from "./format.mjs";
import {
  clearPaneComposer,
  escapePaneComposer,
  hasSession,
  ensureAndAttach,
  attachSession,
  killSession,
  listPanes,
  getPaneStatus,
  selectOption,
  createTmuxContext,
  sendComposerKeys,
  sendToPane,
} from "./tmux.mjs";
import { extractText, extractLastTurn, classifyLines, extractSegments } from "../core/extract.mjs";
import { stripAnsi, esc, extractActivity, formatDuration, validateImagePath } from "../lib.mjs";
import { getContextFromPane, getContextPercent, shortModelName } from "../core/context.mjs";
import { loadSearchRoots, lexicalSearch, formatHits, saveLastResults, loadLastResults, expandHit, withScore, dedupeByFile } from "../core/search.mjs";
import { codexInterruptionFromTurns, planRevive, reviveBrief, parseBootMs } from "../core/revive.mjs";
import { readLastTurns, parseSinceArg, readAllTurnsAcrossPanes, panePathFor, latestJsonlMtime } from "../core/jsonl-reader.mjs";
import { latestCodexJsonlMtime, readLastTurnsCodex } from "../core/codex-jsonl-reader.mjs";
import { detectSenderFromEnv, prependSenderHeader } from "../core/sender-detect.mjs";
import { appendEvent, latestPaneStatesCached, mergeStatus, readEvents } from "../core/events.mjs";
import { isLiveStatus, needsHumanStatus, statusTier, isCompactUnsafe } from "../core/pane-status.mjs";
import { readHeartbeat } from "../core/heartbeat.mjs";
import { assessRunningBridgeHints, syncConfiguredAgentHints } from "../core/hints-sync.mjs";
import { ensureAgentHints, HINTS_VERSION } from "../agent.mjs";
import { expandHome } from "../core/suggestions-comment-bridge.mjs";
import {
  createDeliveryQueue,
  needsDeliveryTerminalNotice,
  TERMINAL_DELIVERY_STATES,
} from "../core/delivery-queue.mjs";
import {
  planOfflineSyncBridge,
  readBridgeMode,
} from "../core/bridge-mode.mjs";
import { createBridgeLifecycle } from "./bridge.mjs";
import { cmdDream, isPidAlive } from "./dream.mjs";
import { cmdDoctor } from "./doctor.mjs";
import {
  collectContextTelemetry, contextTelemetrySnapshot, nativeContextReading,
} from "../core/suggestions-context-telemetry.mjs";
export {
  collectDreamTargets,
  hasDreamPaneBlock,
  isDreamLiveClaudePane,
  isDreamRunnableStatus,
  validateDreamPaneBlock,
  waitForDreamPaneBlock,
} from "./dream.mjs";
import { consumeFleetRestart, queueFleetRestart } from "../core/fleet-restart.mjs";
import {
  groupByPane, previewText,
  isRunningNow, isAskToHuman, looksDone,
} from "../core/orchestrator-checkpoint.mjs";
import { isSystemNoiseDirective } from "../core/system-noise.mjs";
import { composeMorningDigest, digestProjects, boardDecisionItem } from "../core/morning-digest.mjs";
import { collectCommitsSince, reposFromAgents } from "../core/commit-log.mjs";
import { pruneOldSessions, formatJanitorResult } from "../core/janitor.mjs";
import { reapStalePlaywrightProcesses, formatPlaywrightReapResult } from "../core/playwright-watchdog.mjs";
import { regenerateAgentsYaml } from "../sync.mjs";
import yaml from "js-yaml";
import { spawn, execSync } from "child_process";
import { runOneshot, showRunLog } from "./run.mjs";
import { executePlan, showPlanLog } from "./plan.mjs";
import { showEvents } from "./events.mjs";
import { groupNativeTurns, nativeHistoryRows } from "../channels/native-runtime-watcher.mjs";
import {
  discoverNativeRuntimes,
  formatNativeRuntimeStatuses,
  nativeRuntimeStatus,
  startNativeRuntime,
  stopNativeRuntime,
} from "./native-runtime-service.mjs";
import {
  nativeServiceStatus,
  startNativeServices,
  stopNativeServices,
} from "./native-service-manager.mjs";
import {
  createCutoverReceipt,
  cutoverSessionEvidence,
  ensureCutoverProject,
  materializeCutoverConfigs,
  nativeCutoverRequest,
  planNativeCutover,
  readCutoverReceipt,
  recordCutoverPhase,
  restoreCutoverConfigs,
  sourceAfterNativeCutover,
  writeCutoverConfigs,
  writeCutoverReceipt,
} from "../core/native-cutover.mjs";
import { latestPaneSessionIdentity } from "../core/native-session-identity.mjs";
import {
  loadTodos, saveTodos, addTodo, doneTodo, rmTodo, findItem,
  listActive, listRemindable, listDone, formatActiveList, formatReminderSummary, formatItemLine,
  DEFAULT_TODOS_PATH, SECTION_NOW, SECTION_PARKED, SECTION_BLOCKED,
} from "../core/todos.mjs";
import {
  CONTRACT_CHECK_ID,
  formatLintReport,
  lintRoots,
  resolvePathTarget,
} from "../core/contract-lint.mjs";
import {
  askAnchorKey,
  attachAskLineAnchors,
  buildAskEntries,
  filterAskEntries,
} from "../core/ask-history.mjs";
import {
  formatWorktreeDeps,
  provisionWorktreeDependencies,
  runScopedGate,
} from "../core/worktree-deps.mjs";
// Bridge = the Discord bot itself (not a Claude agent). Singleton infra.
const BRIDGE_DIR = resolve(process.env.AGENTMUX_BRIDGE_DIR || resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const bridgeLifecycle = createBridgeLifecycle({ bridgeDir: BRIDGE_DIR });

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
  const configured = getAgent(ctx.configPath, name); // validate exists
  const ready = await ensureAndAttach(ctx, name, ctx.configPath);
  if (configured.backend === "native" || ready?.native) {
    console.log(
      `Native agent '${name}' is ready in AMUX Code (${configured.runtimeUrl || ready?.runtimeUrl}). ` +
      `Use 'amux ${name} -p N "prompt"', 'amux log ${name} -p N', or the web UI.`,
    );
    return;
  }
  attachSession(ctx.socket, name);
}

async function cmdStop(name, ctx) {
  const configured = getAgent(ctx.configPath, name);
  if (configured.backend === "native") {
    console.log(`'${name}' is native and has no tmux session to stop; its sessions remain resumable in AMUX Code.`);
    return;
  }
  if (!(await hasSession(ctx, name))) {
    console.log(`No tmux session for '${name}'.`);
    return;
  }
  await killSession(ctx, name);
  console.log(`Stopped '${name}'.`);
}

async function cmdReconcile(name, ctx) {
  const configured = getAgent(ctx.configPath, name);
  if (configured.backend === "native") {
    const results = await Promise.all(
      configured.panes.map((_, pane) => ctx.agent.nativeRuntime.ensureTarget(name, pane)),
    );
    console.log(`Reconciled native '${name}': ${results.length} agent(s) provisioned, no tmux touched.`);
    return;
  }
  const result = await ctx.agent.reconcileSession(name);
  if (result.skipped) {
    console.log(`Reconcile '${name}' skipped: ${result.reason}.`);
    return;
  }
  const parts = [];
  if (result.added) parts.push(`${result.added} added`);
  if (result.respawned?.length) parts.push(`${result.respawned.length} respawned`);
  if (result.removedExtras?.length) parts.push(`${result.removedExtras.length} idle extras removed`);
  if (result.unchanged) parts.push(`${result.unchanged} unchanged`);
  if (result.extras) parts.push(`${result.extras} active extras left alone`);
  console.log(`Reconciled '${name}': ${parts.join(", ") || "nothing to do"}.`);
  for (const r of result.respawned || []) {
    console.log(`  pane ${r.pane}: ${r.was} → ${r.expected}`);
  }
  for (const m of result.mismatches || []) {
    console.log(`  pane ${m.pane}: has ${m.has}, expected ${m.expected} (left alone)`);
  }
}

/** WHAT: Starts the Discord bridge. WHY: Keeps command dispatch separate from bridge lifecycle policy. */
async function cmdServe(flags, ctx) {
  return bridgeLifecycle.serve(flags, ctx);
}

/** WHAT: Stops the Discord bridge. WHY: Keeps intentional shutdown consistent across CLI callers. */
async function cmdUnserve(ctx) {
  return bridgeLifecycle.stop(ctx);
}

async function cmdRuntime(args, ctx) {
  const { flags, positional } = parseFlags(args, FLAG_SPECS.runtime);
  const action = positional[0] || "status";
  const options = {
    port: flags.port || 8811,
    stateDir: flags["state-dir"],
    dataDir: flags["data-dir"],
    legacyDataDir: flags["no-legacy-migration"] ? null : undefined,
  };
  if (action === "status") {
    const scoped = flags.port !== undefined
      || flags["state-dir"] !== undefined
      || flags["data-dir"] !== undefined;
    if (!scoped) {
      const statuses = await discoverNativeRuntimes();
      console.log(formatNativeRuntimeStatuses(statuses));
      if (!statuses.length) {
        const fallback = await nativeRuntimeStatus(options);
        console.log(`No managed runtime discovered. Default :${fallback.port} is ${fallback.online ? "online but unmanaged" : "offline"}.`);
      }
      return;
    }
    const status = await nativeRuntimeStatus(options);
    console.log(formatNativeRuntimeStatuses(status.managed ? [status] : []));
    if (!status.managed) console.log(`❌ :${status.port} · ${status.online ? "online but unmanaged" : "offline"} · data ${status.paths.dataDir}`);
    console.log(`Log: ${status.paths.logPath}`);
    return;
  }
  if (action === "start") {
    const result = await startNativeRuntime({
      ...options,
      serverPath: resolve(ctx.bridgeDir, "spikes/web-ui/server.mjs"),
    });
    console.log(`Native runtime ${result.alreadyRunning ? "already" : "now"} online at ${result.url} (pid ${result.pid || "external"}).`);
    return;
  }
  if (action === "stop") {
    const result = await stopNativeRuntime({ ...options, force: Boolean(flags.force) });
    console.log(result.alreadyStopped ? "Native runtime already stopped." : "Native runtime stopped; sessions remain persisted.");
    return;
  }
  if (action === "restart") {
    await stopNativeRuntime({ ...options, force: Boolean(flags.force) });
    const result = await startNativeRuntime({
      ...options,
      serverPath: resolve(ctx.bridgeDir, "spikes/web-ui/server.mjs"),
    });
    console.log(`Native runtime restarted at ${result.url} (pid ${result.pid}).`);
    return;
  }
  throw new Error(`unknown runtime action '${action}' (use status|start|stop|restart)`);
}

function configuredServiceTargets(ctx, requested = null) {
  const source = loadSourceYaml(ctx);
  if (requested && !source.agents?.[requested]) throw new Error(`unknown agent '${requested}'`);
  return Object.entries(source.agents || {})
    .filter(([name, agent]) => (!requested || name === requested)
      && Array.isArray(agent.services) && agent.services.length)
    .map(([name, agent]) => ({
      name,
      dir: expandHome(agent.dir),
      services: [...agent.services],
      backend: agent.backend ?? "tmux",
    }));
}

async function cmdServices(args, ctx) {
  const { flags, positional } = parseFlags(args, FLAG_SPECS.services);
  const action = positional[0] || "status";
  const requested = positional[1] || null;
  if (!["status", "start", "stop"].includes(action)) {
    throw new Error(`unknown services action '${action}' (use status|start|stop)`);
  }
  const targets = configuredServiceTargets(ctx, requested);
  if (!targets.length) {
    console.log(requested ? `${requested}: no configured services.` : "No configured services.");
    return;
  }
  for (const target of targets) {
    if (action === "start") {
      if (target.backend !== "native") {
        throw new Error(`${target.name}: service panes are still tmux-owned; cut over before native start`);
      }
      await startNativeServices(target);
    } else if (action === "stop") {
      await stopNativeServices(target, { force: Boolean(flags.force) });
    }
    for (let index = 0; index < target.services.length; index += 1) {
      const status = nativeServiceStatus({
        agentName: target.name,
        index,
        command: target.services[index],
        cwd: target.dir,
      });
      console.log(`${status.managed && status.matchesConfig ? "●" : "○"} ${target.name}:${index} ${
        status.managed ? "running" : "stopped"} · ${target.services[index]} · ${status.paths.logPath}`);
    }
  }
}

const CUTOVER_BLOCKING_STATUSES = new Set([
  "working", "permission", "menu", "resume", "dismiss", "interrupted", "limited",
]);

const cutoverHash = (value) => createHash("sha256").update(String(value)).digest("hex");

export function signalBridgeReload({
  pidPath = process.env.PIDFILE || "/tmp/agentmux.pid",
  kill = process.kill.bind(process),
} = {}) {
  if (!existsSync(pidPath)) throw new Error(`bridge is not running (no pidfile at ${pidPath})`);
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`bridge pidfile is invalid at ${pidPath}`);
  kill(pid, 0);
  kill(pid, "SIGHUP");
  return pid;
}

const cutoverModelAndEffort = async (ctx, target, paneSpec) => {
  const source = loadSourceYaml(ctx).agents[target.name];
  let context = null;
  try { context = await ctx.agent.getContext(target.name, paneSpec.pane); } catch {}
  const commandModel = String(paneSpec.paneConfig?.cmd || "").match(/(?:^|\s)--model\s+([^\s]+)/u)?.[1];
  return {
    model: context?.model || commandModel
      || (paneSpec.engine === "claude" ? source.claudeModel : source.codexModel)
      || (paneSpec.engine === "claude" ? "claude-opus-4-8" : "gpt-5.6-sol"),
    effort: context?.effort || source.effort || (paneSpec.engine === "codex" ? "xhigh" : "medium"),
    inferred: !context?.model || !context?.effort,
  };
};

/** Two independent idle samples plus exact JSONL identity and an empty lane. */
export async function collectCutoverEvidence(ctx, plan, {
  allowEmpty = false,
  pauseMs = 250,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
} = {}) {
  const blockers = [];
  const warnings = [];
  const evidence = {};
  await nativeCutoverRequest(plan.runtimeUrl, "/api/health");

  const samplePane = async (target, paneSpec) => {
    const status = await getPaneStatus(ctx, target.name, paneSpec.pane).catch(() => "unknown");
    const busy = await ctx.agent.isBusy(target.name, paneSpec.pane).catch(() => null);
    return { status, busy };
  };

  for (const target of plan.targets) {
    if (!(await hasSession(ctx, target.name))) {
      blockers.push(`${target.name}: tmux session is not running`);
      continue;
    }
    const livePanes = await listPanes(ctx, target.name);
    const liveIndexes = new Set(livePanes.map((pane) => Number(pane.index)));
    evidence[target.name] = {};
    for (const paneSpec of target.panes) {
      const label = `${target.name}:${paneSpec.pane}`;
      if (!liveIndexes.has(paneSpec.pane)) {
        blockers.push(`${label}: live tmux pane is missing`);
        continue;
      }
      const queued = ctx.deliveryQueue.next(target.name, paneSpec.pane);
      if (queued) blockers.push(`${label}: delivery ${queued.id} is still ${queued.status}`);
      const identity = latestPaneSessionIdentity(paneSpec.engine, paneSpec.sourceCwd);
      if (!identity) {
        if (!allowEmpty) {
          blockers.push(`${label}: exact persisted ${paneSpec.engine} session not found (use --allow-empty only for a deliberately blank pane)`);
          continue;
        }
        const persisted = paneSpec.engine === "codex"
          ? readLastTurnsCodex(paneSpec.sourceCwd, { limit: 1, headless: true })
          : readLastTurns(paneSpec.sourceCwd, { limit: 1, headless: true });
        if (persisted?.turns?.length) {
          blockers.push(`${label}: persisted history exists without an importable session identity`);
          continue;
        }
      }
      const first = await samplePane(target, paneSpec);
      const model = await cutoverModelAndEffort(ctx, target, paneSpec);
      evidence[target.name][paneSpec.pane] = identity
        ? cutoverSessionEvidence(identity, paneSpec.sourceCwd, model, first)
        : {
          sessionId: null,
          cwd: paneSpec.sourceCwd,
          path: null,
          ...model,
          first,
          fresh: true,
          emptyProof: "no persisted engine session or turn history",
        };
      if (model.inferred) warnings.push(`${label}: model or effort inferred from fleet defaults`);
      if (!identity) warnings.push(`${label}: explicitly creating a fresh native session for a proven-empty pane`);
    }
  }
  await sleep(pauseMs);
  for (const target of plan.targets) {
    for (const paneSpec of target.panes) {
      const item = evidence[target.name]?.[paneSpec.pane];
      if (!item) continue;
      const second = await samplePane(target, paneSpec);
      item.second = second;
      for (const [sample, result] of [["first", item.first], ["second", second]]) {
        if (CUTOVER_BLOCKING_STATUSES.has(result.status)) {
          blockers.push(`${target.name}:${paneSpec.pane}: ${sample} sample is ${result.status}`);
        }
        if (result.busy !== false) {
          blockers.push(`${target.name}:${paneSpec.pane}: ${sample} JSONL busy proof is ${String(result.busy)}`);
        }
      }
    }
  }

  const identities = new Map();
  for (const [name, panes] of Object.entries(evidence)) {
    for (const [pane, item] of Object.entries(panes)) {
      if (item.fresh) continue;
      const key = `${item.sessionId}:${item.path}`;
      const previous = identities.get(key);
      if (previous) blockers.push(`${name}:${pane}: session identity is already owned by ${previous}`);
      else identities.set(key, `${name}:${pane}`);
    }
  }
  return { blockers: [...new Set(blockers)], warnings: [...new Set(warnings)], evidence };
}

const formatCutoverPlan = (plan, evidence = null) => {
  const paneCount = plan.targets.reduce((sum, target) => sum + target.panes.length, 0);
  const lines = [
    `Native cutover: ${plan.targets.length} agent group(s), ${paneCount} coding pane(s) → ${plan.runtimeUrl}`,
  ];
  for (const target of plan.targets) {
    const imported = evidence?.[target.name];
    const exact = imported ? Object.values(imported).filter((item) => !item.fresh).length : 0;
    const fresh = imported ? Object.values(imported).filter((item) => item.fresh).length : 0;
    lines.push(`  ${target.name}: ${target.counts.claude} Claude + ${target.counts.codex} Codex${
      imported ? ` · ${exact} exact session(s)${fresh ? ` + ${fresh} proven-empty` : ""}` : ""}`);
  }
  return lines.join("\n");
};

async function rollbackCutoverReceipt(receipt, receiptPath, ctx) {
  const listing = await nativeCutoverRequest(receipt.runtimeUrl, "/api/projects");
  const importedIds = new Set(Object.values(receipt.imports || {}).flatMap((panes) => Object.values(panes)));
  const importedAgents = (listing.projects || []).flatMap((project) => project.agents || [])
    .filter((agent) => importedIds.has(agent.id));
  const running = importedAgents.filter((agent) => agent.running);
  if (running.length) {
    throw new Error(`rollback refused: ${running.length} imported native turn(s) are still running`);
  }
  if (receipt.manageServices) {
    for (const target of [...receipt.targets].reverse()) await stopNativeServices(target, { force: true });
  }
  restoreCutoverConfigs({
    sourcePath: receipt.paths.sourcePath,
    generatedPath: receipt.paths.generatedPath,
    sourceYaml: receipt.original.sourceYaml,
    generatedYaml: receipt.original.generatedYaml,
  });
  signalBridgeReload();
  const restarted = [];
  for (const target of receipt.targets) {
    await ensureAndAttach(ctx, target.name, ctx.configPath);
    if (!(await hasSession(ctx, target.name))) throw new Error(`${target.name}: tmux rollback did not restart`);
    restarted.push(target.name);
  }
  recordCutoverPhase(receipt, "rolled_back", { restarted });
  writeCutoverReceipt(receipt, receiptPath);
  return restarted;
}

export async function cmdCutover(args, ctx) {
  const { flags, positional } = parseFlags(args, FLAG_SPECS.cutover);
  if (flags.rollback) {
    const receipt = readCutoverReceipt(flags.rollback);
    const restarted = await rollbackCutoverReceipt(receipt, flags.rollback, ctx);
    console.log(`Native cutover rolled back byte-exactly; tmux restarted: ${restarted.join(", ")}.`);
    return;
  }
  if (flags.apply && flags.dry) throw new Error("choose either --apply or --dry");
  const sourcePath = agentmuxYamlPath(ctx);
  const generatedPath = ctx.configPath;
  const sourceYaml = readFileSync(sourcePath, "utf8");
  const generatedYaml = readFileSync(generatedPath, "utf8");
  const sourceDoc = yaml.load(sourceYaml);
  const generatedConfig = yaml.load(generatedYaml) || {};
  const plan = planNativeCutover({
    sourceDoc,
    generatedConfig,
    names: positional,
    all: Boolean(flags.all),
    runtimeUrl: flags.runtime,
    manageServices: Boolean(flags["manage-services"]),
    dropServices: Boolean(flags["drop-services"]),
    dropShells: Boolean(flags["drop-shells"]),
  });
  console.log(formatCutoverPlan(plan));
  for (const warning of plan.warnings) console.log(`  WARNING: ${warning}`);
  if (plan.blockers.length) throw new Error(`cutover blocked:\n- ${plan.blockers.join("\n- ")}`);

  const checked = await collectCutoverEvidence(ctx, plan, { allowEmpty: Boolean(flags["allow-empty"]) });
  for (const warning of checked.warnings) console.log(`  WARNING: ${warning}`);
  if (checked.blockers.length) throw new Error(`cutover preflight blocked:\n- ${checked.blockers.join("\n- ")}`);
  console.log(formatCutoverPlan(plan, checked.evidence));
  if (!flags.apply) {
    console.log("DRY RUN GREEN · no process or config changed. Re-run with --apply to cut over.");
    return;
  }

  const receipt = createCutoverReceipt({
    plan,
    sourcePath,
    generatedPath,
    sourceYaml,
    generatedYaml,
  });
  receipt.manageServices = Boolean(flags["manage-services"]);
  const receiptPath = writeCutoverReceipt(receipt);
  const importedIds = {};
  const killed = [];
  const managedServiceTargets = [];
  let configsWritten = false;
  try {
    for (const target of plan.targets) {
      const project = await ensureCutoverProject(target);
      importedIds[target.name] = {};
      receipt.imports[target.name] = {};
      for (const paneSpec of target.panes) {
        const proof = checked.evidence[target.name][paneSpec.pane];
        if (proof.fresh) {
          importedIds[target.name][paneSpec.pane] = null;
          receipt.imports[target.name][paneSpec.pane] = null;
          continue;
        }
        const idempotencyKey = `amux-session-import:${cutoverHash([
          target.generatedId, target.name, paneSpec.pane, proof.sessionId, proof.sourceCwd,
        ].join(":"))}`;
        const imported = await nativeCutoverRequest(target.runtimeUrl,
          `/api/projects/${project.id}/session-imports`, {
            method: "POST",
            body: {
              idempotencyKey,
              name: `${target.name}:${paneSpec.pane}`,
              engine: paneSpec.engine,
              model: proof.model,
              effort: proof.effort,
              address: { session: target.name, pane: paneSpec.pane },
              permissionMode: "automation",
              sessionId: proof.sessionId,
              sourceCwd: proof.sourceCwd,
            },
          });
        if (imported.sessionId !== proof.sessionId || imported.running) {
          throw new Error(`${target.name}:${paneSpec.pane}: runtime import continuity mismatch`);
        }
        importedIds[target.name][paneSpec.pane] = imported.id;
        receipt.imports[target.name][paneSpec.pane] = imported.id;
      }
      recordCutoverPhase(receipt, "imported", { target: target.name });
      writeCutoverReceipt(receipt, receiptPath);
    }

    // Import is read-only against engine history. Re-prove every writer is
    // still idle and every delivery lane empty immediately before teardown.
    const finalCheck = await collectCutoverEvidence(ctx, plan, { allowEmpty: Boolean(flags["allow-empty"]) });
    if (finalCheck.blockers.length) {
      throw new Error(`cutover changed during import:\n- ${finalCheck.blockers.join("\n- ")}`);
    }
    if (cutoverHash(readFileSync(sourcePath, "utf8")) !== receipt.original.sourceSha256
        || cutoverHash(readFileSync(generatedPath, "utf8")) !== receipt.original.generatedSha256) {
      throw new Error("fleet config changed after preflight; retry from the new config");
    }

    for (const target of plan.targets) {
      await killSession(ctx, target.name);
      killed.push(target.name);
      if (flags["manage-services"] && target.services.length) {
        await startNativeServices(target);
        managedServiceTargets.push(target);
      }
      recordCutoverPhase(receipt, "tmux_stopped", { target: target.name });
      writeCutoverReceipt(receipt, receiptPath);
    }

    const nextSource = sourceAfterNativeCutover(sourceDoc, plan, importedIds, {
      dropServices: Boolean(flags["drop-services"]),
      dropShells: Boolean(flags["drop-shells"]),
    });
    const next = materializeCutoverConfigs({
      sourceDoc: nextSource,
      currentGeneratedYaml: generatedYaml,
    });
    writeCutoverConfigs({ sourcePath, generatedPath, ...next });
    configsWritten = true;
    const bridgePid = signalBridgeReload();
    recordCutoverPhase(receipt, "config_switched", { bridgePid });
    writeCutoverReceipt(receipt, receiptPath);

    for (const target of plan.targets) {
      for (const paneSpec of target.panes) {
        const adopted = await ctx.nativeRuntime.ensureTarget(target.name, paneSpec.pane);
        const expected = checked.evidence[target.name][paneSpec.pane].sessionId;
        if (adopted.agent.sessionId !== expected || adopted.agent.running) {
          throw new Error(`${target.name}:${paneSpec.pane}: post-switch continuity verification failed`);
        }
      }
    }
    recordCutoverPhase(receipt, "complete", { killed, verifiedPanes: plan.targets
      .reduce((sum, target) => sum + target.panes.length, 0) });
    writeCutoverReceipt(receipt, receiptPath);
    console.log(`CUTOVER COMPLETE · receipt ${receiptPath}`);
    console.log(`Rollback: amux cutover --rollback '${receiptPath}'`);
  } catch (error) {
    if (killed.length || configsWritten) {
      try {
        for (const target of [...managedServiceTargets].reverse()) {
          await stopNativeServices(target, { force: true });
        }
        restoreCutoverConfigs({
          sourcePath,
          generatedPath,
          sourceYaml: receipt.original.sourceYaml,
          generatedYaml: receipt.original.generatedYaml,
        });
        signalBridgeReload();
        for (const name of killed) await ensureAndAttach(ctx, name, ctx.configPath);
        recordCutoverPhase(receipt, "rolled_back", { reason: error.message, restarted: killed });
      } catch (rollbackError) {
        recordCutoverPhase(receipt, "rollback_failed", {
          reason: error.message,
          rollbackError: rollbackError.message,
        });
        writeCutoverReceipt(receipt, receiptPath);
        throw new Error(`${error.message}; automatic rollback failed: ${rollbackError.message}; receipt ${receiptPath}`);
      }
    } else {
      recordCutoverPhase(receipt, "failed", { reason: error.message });
    }
    writeCutoverReceipt(receipt, receiptPath);
    throw new Error(`${error.message}; no fleet switch remains active; receipt ${receiptPath}`);
  }
}

async function cmdStopAll(ctx) {
  const agents = listAgents(ctx.configPath);
  const stopped = [];
  for (const a of agents) {
    if (a.backend === "native") continue;
    if (await hasSession(ctx, a.name)) {
      await killSession(ctx, a.name);
      stopped.push(a.name);
    }
  }
  if (await cmdUnserve(ctx)) stopped.push("bridge");
  if (!stopped.length) console.log("Nothing to stop.");
  else console.log(`Stopped: ${stopped.join(", ")}.`);
}

async function cmdSend(name, prompt, flags, ctx) {
  saveLast(ctx.lastFile, name);
  const pane = flags.p || 0;

  // Auto-prepend [from <session>:<window>] when invoker is inside tmux,
  // so receiver panes know which orchestrator briefed them. Invisible
  // when called from raw terminal, Discord bot, or cron (no TMUX env).
  // Sender is invariant — provenance must never be silently erased.
  const exec = (cmd) => execSync(cmd, { encoding: "utf8", timeout: 2000 });
  const sender = detectSenderFromEnv(process.env, exec);
  const finalPrompt = prependSenderHeader(prompt, sender);

  const idempotencyKey = flags["idempotency-key"];
  if (idempotencyKey != null
      && (typeof idempotencyKey !== "string" || Buffer.byteLength(idempotencyKey, "utf8") > 256
        || !/^[a-zA-Z0-9:._/-]+$/u.test(idempotencyKey))) {
    throw new Error("--idempotency-key must be 1-256 safe identity characters");
  }
  const waitMs = flags["wait-ms"];
  if (waitMs != null && (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 12_000)) {
    throw new Error("--wait-ms must be 0-12000");
  }
  const res = await sendToPane(ctx, name, pane, finalPrompt, {
    force: !!flags.force,
    idempotencyKey: idempotencyKey || null,
    ...(waitMs != null ? { waitMs } : {}),
  });
  if (res?.blocked) {
    process.exitCode = 1;
    return;
  }
  if (res?.unverified) {
    console.error(`Delivery unverified for '${name}' (pane ${pane}); AMUX will not resend automatically.`);
    process.exitCode = 1;
    return;
  }
  if (!res?.delivered) {
    process.exitCode = 1;
    return;
  }
  if (!flags.q) console.log(`${res.pending ? "Queued durably for" : "Sent to"} '${name}' (pane ${pane}): ${truncate(prompt)}`);
}

export async function readPromptFromStdin(maxBytes = 128 * 1024, stream = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new Error(`--stdin prompt exceeds ${maxBytes} bytes`);
    chunks.push(bytes);
  }
  const prompt = Buffer.concat(chunks).toString("utf8");
  if (!prompt.trim()) throw new Error("--stdin requires a non-empty prompt");
  return prompt;
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
    } else if (status === "interrupted") {
      // The turn died (Esc/stream error) — nothing to wait for; a caller
      // blocking here would hang until timeout (ai:4 sat 40 min like this).
      if (sawWorking || idleStreak >= 4) { console.log("interrupted"); process.exit(4); }
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

function readLastTurnsForPane(agent, paneIdx, paneDir, opts) {
  const cmd = agent?.panes?.[paneIdx]?.cmd || "";
  return /codex/i.test(cmd)
    ? readLastTurnsCodex(paneDir, opts)
    : readLastTurns(paneDir, opts);
}

async function cmdLog(name, flags, ctx) {
  const pane = flags.p || 0;

  try { validateAgentAndPane(ctx, name, pane); }
  catch (err) { console.error(err.message); process.exit(1); }

  if (!(await hasSession(ctx, name))) {
    console.error(`No live runtime for '${name}'. Run 'amux ${name}' to start or provision it.`);
    process.exit(1);
  }

  const configured = getAgent(ctx.configPath, name);
  if (configured.backend === "native" && !flags.tmux && !flags.text && !flags.t) {
    const snapshot = await ctx.agent.nativeRuntime.history(name, pane);
    let turns = groupNativeTurns(snapshot.events);
    const since = parseSinceArg(flags.since);
    if (flags.since && !since) {
      console.error(`invalid --since '${flags.since}'. Use ISO or relative ("30min", "2h", "1d").`);
      process.exit(1);
    }
    if (since) turns = turns.filter((turn) => turn.endAt >= since.getTime());
    if (flags.grep) {
      let pattern;
      try { pattern = new RegExp(flags.grep, "i"); }
      catch (error) {
        console.error(`invalid --grep regex: ${error.message}`);
        process.exit(1);
      }
      turns = turns.filter((turn) => pattern.test(`${turn.user}\n${turn.items.map((item) => item.content).join("\n")}`));
    }
    turns = turns.slice(-(flags.n || 3));
    if (!turns.length) {
      console.log("(no native turns found)");
      return;
    }
    for (const turn of turns) {
      console.log(`USER  ${new Date(turn.userAt || turn.endAt).toISOString()}`);
      console.log(turn.user);
      console.log("ASSISTANT");
      console.log(turn.items.map((item) => item.type === "tool" ? `[tool] ${item.content}` : item.content).join("\n\n"));
      console.log("");
    }
    if (flags.full || flags.f) {
      console.log("═══ native runtime ═══");
      console.log(await ctx.agent.capturePane(name, pane));
    }
    return;
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

  // Resolve paneDir for jsonl lookup. Each pane runs claude from its own
  // worktree (`${agent.dir}/.agents/${paneIdx}`), so claude's session store
  // is keyed off that subdir, not the agent root. Use panePathFor to match
  // the convention used by readAllTurnsAcrossPanes / cmdDone.
  const agent = configured;
  const paneDir = panePathFor(agent, pane);

  // --- full: jsonl history + current tmux state ---
  if (flags.full || flags.f) {
    const since = parseSinceArg(flags.since);
    const grep = flags.grep ? new RegExp(flags.grep, "i") : null;
    const limit = flags.n || 3;
    const jsonl = readLastTurnsForPane(agent, pane, paneDir, { limit, since, grep });
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
  const jsonl = readLastTurnsForPane(agent, pane, paneDir, { limit, since, grep });
  if (!jsonl) {
    console.error(
      `no jsonl found for '${paneDir}'. ` +
      `Pane may not have run claude/codex yet, or session is in a different cwd. ` +
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
  event: "🔔",
  delivery: "📨",
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
  if (row.type === "delivery") return "delivery";
  if (row.type === "event") return "event";
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

// Bounded jsonl reads for the timeline: 4MB tail per pane holds far more
// than any realistic display window, and tailFallback grows the window when
// --since reaches further back. Without this, timeline full-parsed every
// pane's session file (100MB+ sessions → 18s wall for `timeline --since 2h`).
const TIMELINE_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * Pull a snapshot of rows from all configured panes, respecting filters.
 * Validates flags inline so both cmdTimeline and cmdWatch share the parsing.
 * sinceOverride (Date) narrows the read window without touching flag parsing;
 * followTimeline uses it to poll incrementally instead of re-reading the
 * whole window every second.
 */
function collectTimelineRows(ctx, flags, { applyLimit, sinceOverride = null }) {
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

  if (sinceOverride) since = sinceOverride;

  const limit = applyLimit ? (flags.n || 30) : null;
  const turns = readAllTurnsAcrossPanes({
    agents, since, agent: agentFilter, pane: paneFilter, grep, limit: null,
    tailBytes: TIMELINE_TAIL_BYTES,
  });
  const rows = turns.concat(
    ledgerTimelineRows({ since, agentFilter, paneFilter, grep }),
  );
  rows.sort((x, y) => {
    const tx = x.timestamp ? Date.parse(x.timestamp) : Number.POSITIVE_INFINITY;
    const ty = y.timestamp ? Date.parse(y.timestamp) : Number.POSITIVE_INFINITY;
    return tx - ty;
  });
  return (typeof limit === "number" && rows.length > limit) ? rows.slice(-limit) : rows;
}

/**
 * Hook-ledger events as timeline rows: permission asks and session starts
 * are exactly the "what happened while I was away" signals turns can't show
 * (a blocked permission never reaches the jsonl). Turn boundaries
 * (prompt/stop) are skipped — the turns themselves already show those.
 */
function ledgerTimelineRows({ since, agentFilter, paneFilter, grep }) {
  let events;
  try {
    events = readEvents(since ? { since } : {});
  } catch {
    return []; // hint layer only: an unreadable ledger never breaks timeline
  }
  const rows = [];
  for (const evt of events) {
    const known = evt.event === "notification" || evt.event === "session_start"
      || evt.event === "delivery" || evt.event === "context_loss"
      || evt.event === "model_change";
    if (!known) continue;
    if (agentFilter && evt.session !== agentFilter) continue;
    if (paneFilter != null && evt.pane !== paneFilter) continue;

    let content;
    let type = "event";
    if (evt.event === "delivery") {
      // Delivered prompts already appear as user turns from the pane's own
      // jsonl — only receipts with NO jsonl trace add signal here: failed
      // deliveries (THE row to find when "I sent it" meets "it never
      // arrived") and slash commands (which never become turns).
      if (evt.delivered && evt.kind === "prompt") continue;
      type = "delivery";
      content = evt.delivered
        ? `delivered ${evt.kind}: ${evt.detail || ""}${evt.rescues ? ` (rescued x${evt.rescues})` : ""}`
        : `NOT DELIVERED (${evt.kind}, ${evt.attempts ?? "?"} attempts): ${evt.detail || ""}`;
    } else {
      content = evt.event === "session_start"
        ? `session start${evt.source ? ` (${evt.source})` : ""}`
        : evt.event === "model_change"
          ? `MODEL ${evt.direction === "downgrade" ? "⬇" : evt.direction === "upgrade" ? "⬆" : "→"} ${evt.detail || ""}`
          : evt.event === "context_loss"
          ? `CONTEXT LOSS: ${evt.detail || "(no detail)"}`
          : `${evt.needsYou ? "permission" : "notify"}: ${evt.detail || "(no detail)"}`;
    }
    if (grep && !grep.test(content)) continue;
    rows.push({
      timestamp: evt.ts, agent: evt.session, pane: evt.pane,
      role: "system", type, content,
    });
  }
  return rows;
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

  // Incremental polling: each tick only reads a short trailing window (the
  // emitted-set dedups the overlap) instead of re-reading the full --since
  // window every second — that made watch permanently lag behind on big
  // sessions. The overlap absorbs clock skew and slow writers.
  const POLL_OVERLAP_MS = 30 * 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, TIMELINE_POLL_MS));
    const sinceOverride = new Date(Date.now() - POLL_OVERLAP_MS);
    const rows = collectTimelineRows(ctx, flags, { applyLimit: false, sinceOverride });
    for (const r of rows) {
      const k = rowKey(r);
      if (emitted.has(k)) continue;
      emitted.add(k);
      console.log(formatTimelineRow(r));
    }
    // Bound the dedup set on long watches (Set iterates in insertion order).
    if (emitted.size > 20000) {
      for (const k of emitted) {
        emitted.delete(k);
        if (emitted.size <= 10000) break;
      }
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

// --- Asks: human directive ledger -----------------------------------------

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function escapeRegexLiteral(s) {
  return String(s).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function promptFromJsonlLine(event) {
  if (event?.type === "user" && typeof event.message?.content === "string") {
    return { timestamp: event.timestamp || null, prompt: event.message.content };
  }
  if (event?.type === "event_msg" && event.payload?.type === "user_message" && typeof event.payload.message === "string") {
    return { timestamp: event.timestamp || null, prompt: event.payload.message };
  }
  return null;
}

function collectAskLineAnchors(jsonlFile) {
  const out = new Map();
  if (!jsonlFile) return out;
  let text;
  try { text = readFileSync(jsonlFile, "utf-8"); }
  catch { return out; }

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let event;
    try { event = JSON.parse(lines[i]); } catch { continue; }
    const anchor = promptFromJsonlLine(event);
    if (!anchor?.prompt) continue;
    const key = askAnchorKey(anchor.timestamp, anchor.prompt);
    if (!out.has(key)) out.set(key, i + 1);
  }
  return out;
}

function attachDisplayedAskLineAnchors(rows) {
  const cache = new Map();
  return rows.map((row) => {
    if (!row.jsonlFile) return row;
    if (!cache.has(row.jsonlFile)) {
      cache.set(row.jsonlFile, collectAskLineAnchors(row.jsonlFile));
    }
    return attachAskLineAnchors([row], cache.get(row.jsonlFile))[0];
  });
}

function formatAskStatus(status) {
  switch (status) {
    case "open": return "⚠️ open";
    case "working": return "🟡 working";
    case "partial": return "⚠️ partial";
    case "needs-you": return "🔴 needs-you";
    case "done": return "✅ done";
    case "answered": return "☑️ answered";
    default: return status || "unknown";
  }
}

function formatAskEntry(e) {
  const ts = e.timestamp ? new Date(e.tsMs).toISOString().slice(5, 16).replace("T", " ") : "-- --:--";
  const age = Number.isFinite(e.ageMs) ? formatRelMin(Math.round(e.ageMs / 60000)) : "?";
  const status = formatAskStatus(e.status).padEnd(13);
  const head = `${status}  ${ts}  ${e.key.padEnd(10)}  ${age}`;
  const needle = oneLine(e.prompt).slice(0, 70);
  const lines = [
    head,
    `    > ${e.promptPreview}`,
  ];
  if (e.replyPreview) lines.push(`    → ${e.replyPreview}`);
  if (e.jsonlFile) {
    const loc = e.jsonlLine ? `${e.jsonlFile}:${e.jsonlLine}` : e.jsonlFile;
    lines.push(`    jsonl: ${loc}${e.timestamp ? ` @ ${e.timestamp}` : ""}`);
  }
  lines.push(`    log: amux log ${e.agent} -p ${e.pane} --grep ${shellQuote(escapeRegexLiteral(needle))} -n 5`);
  return lines.join("\n");
}

async function cmdAsks(ctx, flags, positional = []) {
  const nowMs = Date.now();
  const agentFilter = flags.agent || positional[0] || null;
  const paneFilter = flags.pane ?? flags.p ?? null;
  let resolvedAgent = null;

  if (agentFilter) {
    resolvedAgent = resolveAgent(agentFilter, ctx.configPath);
    const known = listAgents(ctx.configPath).map((a) => a.name);
    if (!known.includes(resolvedAgent)) {
      console.error(`unknown agent '${agentFilter}'. Known: ${known.join(", ") || "(none)"}`);
      process.exit(1);
    }
  }
  if (paneFilter != null && !resolvedAgent) {
    console.error("--pane requires an agent filter: amux asks <agent> --pane N");
    process.exit(1);
  }
  if (resolvedAgent && paneFilter != null) {
    try { validateAgentAndPane(ctx, resolvedAgent, paneFilter); }
    catch (err) { console.error(err.message); process.exit(1); }
  }

  let since = null;
  let sinceLabel = "--all";
  if (!flags.all) {
    const rawSince = flags.since || "7d";
    since = parseSinceArg(rawSince);
    if (!since) {
      console.error(`invalid --since '${rawSince}'. Use ISO or relative ("30min", "2h", "1d").`);
      process.exit(1);
    }
    sinceLabel = rawSince;
  }

  let grep = null;
  if (flags.grep) {
    try { grep = new RegExp(flags.grep, "i"); }
    catch (err) {
      console.error(`invalid --grep regex: ${err.message}`);
      process.exit(1);
    }
  }

  const agents = listAgents(ctx.configPath)
    .filter((a) => !resolvedAgent || a.name === resolvedAgent);
  const targets = [];
  for (const a of agents) {
    for (let paneIdx = 0; paneIdx < (a.panes || []).length; paneIdx++) {
      if (paneFilter != null && paneIdx !== paneFilter) continue;
      const cmd = a.panes[paneIdx]?.cmd || "";
      if (!/^(claude|codex)/.test(cmd)) continue;
      targets.push({ agent: a, pane: paneIdx });
    }
  }

  const statuses = new Map(await Promise.all(targets.map(async ({ agent, pane }) => {
    const status = await getPaneStatus(ctx, agent.name, pane).catch(() => "unknown");
    return [`${agent.name}:${pane}`, status];
  })));

  const perPaneLimit = flags["per-pane"] || (flags.full ? 200 : 20);
  const entries = [];
  for (const { agent, pane } of targets) {
    const paneDir = panePathFor(agent, pane);
    const readOpts = flags.full
      ? { limit: perPaneLimit, since, grep }
      : { limit: perPaneLimit, tailBytes: 4 * 1024 * 1024 };
    const res = readLastTurnsForPane(agent, pane, paneDir, readOpts);
    if (!res?.turns?.length) continue;
    entries.push(...buildAskEntries({
      agent: agent.name,
      pane,
      turns: res.turns,
      jsonlFile: res.jsonlFile,
      paneStatus: statuses.get(`${agent.name}:${pane}`) || "unknown",
      nowMs,
    }));
  }

  const rows = attachDisplayedAskLineAnchors(filterAskEntries(entries, {
    sinceMs: since ? since.getTime() : null,
    grep,
    openOnly: !!flags.open,
    limit: flags.n || 40,
  }));

  const mode = flags.full ? "full scan" : "bounded tail";
  const filter = [
    `since=${sinceLabel}`,
    flags.open ? "open-only" : "all statuses",
    resolvedAgent ? `agent=${resolvedAgent}` : null,
    paneFilter != null ? `pane=${paneFilter}` : null,
  ].filter(Boolean).join(", ");
  console.log(`\nAsks (${mode}, ${filter})`);
  if (!rows.length) {
    console.log("(no asks match)");
    if (!flags.full) console.log("Try: amux asks --full --since 30d");
    return;
  }
  for (const e of rows) console.log("\n" + formatAskEntry(e));
  if (!flags.full) {
    console.log(`\nℹ bounded tail view. For exact older history: amux asks --full --since 30d`);
  }
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
/**
 * Which pane is running this command, as an "agent:pane" key — or null when
 * not invoked from inside a tmux pane. Lets `amux done`/`ps` self-orient ("you
 * are claw:3") so an agent that lost its context (post-compact, fresh spawn)
 * can find its own thread first. Best-effort; never throws.
 */
function detectSelfKey() {
  try {
    return detectSenderFromEnv(process.env, (cmd) => execSync(cmd, { encoding: "utf8", timeout: 2000 }));
  } catch { return null; }
}

/** Render the "you are here" block at the top of `amux done`. */
function renderSelfBlock(selfKey, widerBuckets, statuses, nowMs) {
  if (!selfKey) return;
  const [aname, pidx] = selfKey.split(":");
  const log = `amux log ${aname} -p ${pidx} -n 30`;
  console.log(`\n▸ DU = ${selfKey}  (denna panel / this pane)`);
  const b = widerBuckets.get(selfKey);
  if (!b || !b.turns) {
    console.log(`   ingen aktivitet i fönstret.  📜 full historik: ${log}`);
    return;
  }
  const lastUser = previewText(stripAnsi((b.recentUserTexts?.slice(-1)[0]) || b.lastUserText || ""), 80);
  const lastAsst = previewText(stripAnsi(b.lastAssistantText || ""), 90);
  const status = statuses.get(selfKey) || "unknown";
  let state = "🟡 jobbar";
  if (needsHumanStatus(status)) state = "🔴 väntar på input";
  else if (isAskToHuman(b.lastAssistantText, b.lastUserText)) state = "🔴 du väntar på svar (från Mattias)";
  else if (isLiveStatus(status) || isRunningNow(b, nowMs)) state = "🟡 jobbar";
  else if (looksDone(b.lastAssistantText)) state = "✅ klar";
  else state = "⚠️ idle, ev. mer att göra (sa aldrig 'klart')";
  if (lastUser) console.log(`   senast ombedd:  "${lastUser}"`);
  if (lastAsst) console.log(`   du svarade:     "${lastAsst}"`);
  console.log(`   läge: ${state}`);
  console.log(`   📜 full historik: ${log}`);
}

async function cmdDone(ctx, flags) {
  const nowMs = Date.now();
  let sinceMs = null;
  let sinceSource = "";

  // Pure time-window resolution. No state, no checkpoint, fully idempotent.
  // Multiple agents can run done in parallel without races; humans can call
  // it back-to-back and get consistent output.
  //
  // Mode resolution (mutually exclusive, first match wins):
  //   --day            → 24h window
  //   --week           → 7d window
  //   --all            → 30d window
  //   --since <expr>   → explicit window
  //   (no flags)       → 1h window (default)
  if (flags.day) {
    sinceMs = nowMs - 24 * 60 * 60 * 1000;
    sinceSource = "--day (24h)";
  } else if (flags.week) {
    sinceMs = nowMs - 7 * 24 * 60 * 60 * 1000;
    sinceSource = "--week (7d)";
  } else if (flags.all) {
    sinceMs = nowMs - 30 * 24 * 60 * 60 * 1000;
    sinceSource = "--all (30d max)";
  } else if (flags.since) {
    const parsed = parseSinceArg(flags.since);
    if (!parsed) {
      console.error(`invalid --since '${flags.since}'. Use ISO or relative ("30min", "2h", "1d").`);
      process.exit(1);
    }
    sinceMs = parsed.getTime();
    sinceSource = `--since ${flags.since}`;
  } else {
    sinceMs = nowMs - 60 * 60 * 1000;
    sinceSource = "default (1h)";
  }

  const agents = listAgents(ctx.configPath);

  // Single jsonl read for both the current cutoff and the 7d recent-activity
  // feed: read at the EARLIER of the two and slice in memory. Previously this
  // read every pane's jsonl twice whenever the cutoff was narrower than 7d
  // (the common default-1h case) — the dominant cost in `amux done`.
  const widerSinceMs = nowMs - 7 * 24 * 3600 * 1000;
  const readCutoffMs = Math.min(sinceMs, widerSinceMs);
  // Bounded tail per pane (no full-read fallback): on a 100MB+ session a full
  // parse per pane was the whole cost of `amux done`. 4MB holds plenty of
  // recent turns for classification + the recent feed; the latest user/
  // assistant text (what classify + preview need) always lives in the tail.
  // The only casualty is an exact turn count on the most hyperactive panes,
  // which is informational. See eventsFromProjectDir's tailFallback:false.
  const allRows = readAllTurnsAcrossPanes({
    agents, since: new Date(readCutoffMs), tailBytes: 4 * 1024 * 1024, tailFallback: false,
  });
  // Native engines do not write their session JSONL under the legacy
  // per-pane tmux directories. Pull their completed turns from the runtime
  // so an opted-in canary remains first-class in the broker's `amux done`
  // view. An offline canary cannot make the legacy fleet command fail.
  if (ctx.agent.nativeRuntime) {
    const nativeRows = await Promise.all(agents
      .filter((agent) => agent.backend === "native")
      .flatMap((agent) => (agent.panes || []).map(async (_paneConfig, pane) => {
        try {
          const snapshot = await ctx.agent.nativeRuntime.history(agent.name, pane);
          return nativeHistoryRows(agent.name, pane, snapshot.events, { sinceMs: readCutoffMs });
        } catch {
          return [];
        }
      })));
    allRows.push(...nativeRows.flat());
    allRows.sort((a, b) => Date.parse(a.timestamp || 0) - Date.parse(b.timestamp || 0));
  }
  const sliceFrom = (cutoff) => cutoff <= readCutoffMs
    ? allRows
    : allRows.filter((r) => r.timestamp && Date.parse(r.timestamp) >= cutoff);
  const buckets = groupByPane(sliceFrom(sinceMs));
  // Open-loop detection (needs-you / stalled) scans the WIDER of the two
  // windows so a dropped ball from before the cutoff still surfaces — that's
  // the whole point ("I asked something days ago, did it ever land?"). Reused
  // for the recent-activity feed too, so it's computed once here.
  const widerBuckets = sinceMs <= widerSinceMs ? buckets : groupByPane(sliceFrom(widerSinceMs));

  // Also enumerate panes with ZERO turns so "idle" count stays honest.
  // Each agent in config has a known pane list regardless of jsonl state.
  const allPaneKeys = new Set();
  for (const a of agents) {
    const panes = Array.isArray(a.panes) ? a.panes : [];
    for (let i = 0; i < panes.length; i++) allPaneKeys.add(`${a.name}:${i}`);
  }

  // Attention-first categories (replaces the old finished/waiting/working
  // split). Detection runs over the WIDER window so old open loops surface:
  //   🔴 needsYou  — blocked on the human (a question back, or a live modal)
  //   ⚠️ stalled   — got a directive, went idle >30min, never signalled done
  //   🟡 working   — live right now
  //   ✅ doneRecent— finished with a completion signal, within the cutoff
  //   💤 idle      — no turns, or old-and-done (just counted)
  const STALL_MIN_MS = 30 * 60 * 1000;
  const needsYou = [];
  const stalled = [];
  const working = [];
  const doneRecent = [];
  let idleCount = 0;

  // Fetch every pane's live tmux status in parallel — each getPaneStatus is
  // a capture-pane subprocess spawn, and doing ~40 of them sequentially was
  // the second cost driver here. tmux handles concurrent capture fine.
  const statuses = new Map(
    await Promise.all([...allPaneKeys].map(async (key) => {
      const [agentName, paneStr] = key.split(":");
      const status = await getPaneStatus(ctx, agentName, parseInt(paneStr, 10)).catch(() => "unknown");
      return [key, status];
    })),
  );

  for (const key of allPaneKeys) {
    const [agentName, paneStr] = key.split(":");
    const paneIdx = parseInt(paneStr, 10);
    const bucket = widerBuckets.get(key) || {
      agent: agentName, pane: paneIdx, turns: 0,
      latestTurnTs: null,
      lastUserText: null, lastUserTextTs: null,
      recentUserTexts: [],
      lastAssistantText: null, lastAssistantTextTs: null,
    };
    const status = statuses.get(key) || "unknown";
    const ageMs = bucket.latestTurnTs ? nowMs - bucket.latestTurnTs : Infinity;
    const inWindow = bucket.latestTurnTs != null && bucket.latestTurnTs >= sinceMs;
    const live = isLiveStatus(status) || isRunningNow(bucket, nowMs);
    // "Dropped ball": the human's directive is the most recent text and the
    // agent never replied (and isn't live). This is the precise "I asked, it
    // never got done" signal — far tighter than "didn't end with 'klart'".
    // System banners (resume/continuation) don't count as the user speaking.
    const userSpokeLast = bucket.lastUserTextTs
      && bucket.lastUserTextTs > (bucket.lastAssistantTextTs || 0)
      && !isSystemNoiseDirective(bucket.lastUserText);
    const entry = { key, bucket, status, ageMs };

    if (needsHumanStatus(status)) needsYou.push(entry);                              // modal/interrupted blocks on user
    else if (live) working.push(entry);
    else if (bucket.turns === 0) idleCount++;
    else if (userSpokeLast && ageMs > STALL_MIN_MS) stalled.push(entry);             // directive unanswered → dropped
    else if (isAskToHuman(bucket.lastAssistantText, bucket.lastUserText)) needsYou.push(entry); // agent asked the HUMAN something
    else if (inWindow) doneRecent.push(entry);                                       // replied within the window
    else idleCount++;                                                                // old + already replied
  }

  // Freshest events first per category.
  const byTsDesc = (a, b) => (b.bucket.latestTurnTs || 0) - (a.bucket.latestTurnTs || 0);
  needsYou.sort(byTsDesc);
  stalled.sort(byTsDesc);
  working.sort(byTsDesc);
  doneRecent.sort(byTsDesc);

  const selfKey = detectSelfKey();

  const sinceIso = new Date(sinceMs).toISOString().slice(0, 16).replace("T", " ");
  const ageMin = Math.round((nowMs - sinceMs) / 60000);
  console.log(`\nSince ${sinceIso} UTC (${ageMin} min ago, source: ${sinceSource})`);

  // Self-orientation: if run from inside a pane, show that pane's own state
  // first so a context-less agent re-anchors before reading everyone else.
  renderSelfBlock(selfKey, widerBuckets, statuses, nowMs);

  // "Where were we" header: top 5 most recent items across the system,
  // pulled from a 7d window — independent of the current cutoff so it
  // stays informative even when --day/--week aren't passed. Helps a
  // morning-after orchestrator see "last 5 things" at a glance, in
  // chronological order, before scanning the bucket sections below. The 7d
  // slice (widerBuckets) was computed once up top — no second jsonl pass.
  const widerCommits = collectCommitsSince(reposFromAgents(agents), widerSinceMs, 20);
  const recentItems = [];
  for (const b of widerBuckets.values()) {
    if (b.latestTurnTs) recentItems.push({ kind: "pane", ts: b.latestTurnTs, bucket: b });
  }
  for (const c of widerCommits) {
    recentItems.push({ kind: "commit", ts: c.ts, commit: c });
  }
  recentItems.sort((a, b) => b.ts - a.ts);
  const top = recentItems.slice(0, 20);
  if (top.length) {
    console.log(`\nRecent activity (top ${top.length}):`);
    for (const item of top) {
      const min = Math.round((nowMs - item.ts) / 60000);
      const age = formatRelMin(min);
      if (item.kind === "commit") {
        const c = item.commit;
        const subj = truncate(c.subject, 50);
        console.log(`  📝 ${c.hash.slice(0, 7)}  ${c.label.padEnd(10).slice(0, 10)}  ${subj.padEnd(52)}  (${age})`);
      } else {
        const b = item.bucket;
        const preview = truncate((b.lastAssistantText || b.lastUserText || "").replace(/\s+/g, " ").trim(), 50);
        const key = `${b.agent}:${b.pane}`.padEnd(10);
        console.log(`  🔸 ${key}            ${preview.padEnd(52)}  (${age})`);
      }
    }
  }

  // Commits are the strongest "work happened" signal — code was written,
  // reviewed, and kept. Render first so it anchors the orchestrator's
  // situational awareness before the classifier-based sections.
  const commits = collectCommitsSince(reposFromAgents(agents), sinceMs, 20);
  if (commits.length) {
    console.log(`\n📝 ${commits.length} commit${commits.length === 1 ? "" : "s"}`);
    for (const c of commits) console.log("  " + formatCommitRow(c));
  }

  // Arrow legend: the pane rows below carry a 2-line thread block. Spelled
  // out once so an agent reading this knows what it's looking at without a
  // follow-up `amux log`.
  const hasThreadRows = needsYou.length || stalled.length || working.length || doneRecent.length;
  if (hasThreadRows) {
    console.log(`\n  (per panel:  ← senaste direktiv den fick   → dess senaste svar)`);
  }

  // Render a category with a cap so a busy system doesn't bury the actionable
  // sections under a wall of rows. Drops are surfaced, never silent.
  const CAP = 8;
  const section = (rows, header, rowOpts = {}) => {
    if (!rows.length) return;
    console.log(`\n${header}`);
    for (const e of rows.slice(0, CAP)) console.log("  " + formatDoneRow(e, rowOpts));
    if (rows.length > CAP) console.log(`  … +${rows.length - CAP} till (amux done --week för alla)`);
  };

  // Attention-first ordering: what needs the human, then dropped balls, then
  // live work, then recent completions.
  section(needsYou, `🔴 ${needsYou.length} väntar på DITT svar (bollen hos dig / needs you)`, { showAge: true });
  section(stalled, `⚠️ ${stalled.length} kanske tappad (idle >30min, sa aldrig "klart" / maybe dropped)`, { showAge: true });
  section(working, `🟡 ${working.length} jobbar nu (working)`);
  section(doneRecent, `✅ ${doneRecent.length} klar (done)`);

  const anySection = commits.length || needsYou.length || stalled.length || working.length || doneRecent.length;
  if (!anySection) {
    console.log(`\n(no activity since cutoff, ${idleCount} panes idle)`);
  } else {
    console.log(`\n💤 ${idleCount} idle (no activity since cutoff)`);
  }

  // Next-step hints. Agents start fresh each session and don't remember
  // flag semantics — explicit command + comment beats compact one-liner.
  // Lines are contextual: only include hints relevant to what the user
  // is likely to want next given the current output state.
  console.log(`\nℹ More:`);
  console.log(`  amux done --week                              # full week, peek-only`);
  if (commits.length) {
    const c0 = commits[0];
    // Use actual repo path from the commit, not the agent label — labels
    // can mismatch (e.g. agent "claw" but repo at ~/.openclaw/workspace).
    console.log(`  cd ${c0.repo} && git show ${c0.hash.slice(0, 7)}  # full commit body for ${c0.label}`);
    console.log(`  cd ${c0.repo} && git log -20                  # commit history for ${c0.label}`);
  }
  // Drill-down to the most actionable pane: a waiter first, else a dropped
  // ball, else live work. Full text is one command away (rich-but-reachable).
  const focus = needsYou[0] || stalled[0] || working[0];
  if (focus) {
    const [aname, pidx] = focus.key.split(":");
    const why = needsYou[0] ? "this waiter" : stalled[0] ? "this maybe-dropped pane" : "this pane";
    console.log(`  amux log ${aname} -p ${pidx} -n 5            # FULL text from ${why}`);
    // Coordination primitive: how one agent answers / hands off to another.
    console.log(`  amux ${aname} -p ${pidx} "<message>"${" ".repeat(Math.max(1, 22 - aname.length - String(pidx).length))}# answer it / hand the task to it`);
  }
  if (needsYou.length || stalled.length) {
    console.log(`  amux asks --open                            # all open asks with jsonl location`);
  } else {
    console.log(`  amux asks --since 2h                        # recent asks/directives with jsonl location`);
  }
  if (top.length) {
    // Generic "see full" hint for the top-20 recent activity feed — preview
    // text is truncated to ~50 chars, full message lives in jsonl/git.
    console.log(`  amux log <agent> -p <N> -n 1                 # full text of any pane in 'Recent activity'`);
  }
  console.log(`  amux timeline --grep "<keyword>"              # find which pane you asked about X`);
  if (!anySection) {
    console.log(`  amux done --all                              # widen to 30d (max safety cap)`);
  }
}

async function cmdTopic(ctx, agentName, paneIdx, text) {
  const { setChannelTopicThrottled } = await import("./send-notify.mjs");
  const channelId = findChannelForPane(ctx.configPath, agentName, paneIdx);
  if (!channelId) {
    console.log(`topic skipped on ${agentName}:${paneIdx} (no Discord channel bound)`);
    return;
  }
  const r = await setChannelTopicThrottled(channelId, text);
  if (r.updated) {
    console.log(`topic set on ${agentName}:${paneIdx} → "${text.slice(0, 80)}"`);
  } else if (r.reason?.startsWith("throttled")) {
    console.log(`topic throttled on ${agentName}:${paneIdx} (skipped this call)`);
  } else if (r.reason?.startsWith("unchanged")) {
    console.log(`topic unchanged on ${agentName}:${paneIdx}`);
  } else {
    console.error(`topic failed: ${r.reason || "unknown"}`);
    process.exit(1);
  }
}

async function cmdNotifyUser(args) {
  const { notifyUser, formatUserNotification } = await import("./send-notify.mjs");
  const { flags, positional } = parseFlags(args, {
    level: "string", l: "string",
    title: "string",
    user: "string", u: "string",
    channel: "string", c: "string",
    force: "boolean", f: "boolean",
    dry: "boolean",
    test: "boolean",
    "idempotency-key": "string",
  });
  const level = flags.level || flags.l || "info";
  const title = flags.title || "amux";
  const text = flags.test
    ? "Test notification from amux notifyuser."
    : positional.join(" ").trim();
  if (!text) {
    console.error(`Usage: amux notifyuser "message" [--level info|done|warn|error] `
      + `[--idempotency-key KEY] [--force]`);
    process.exit(1);
  }
  const opts = {
    level,
    title,
    userId: flags.user || flags.u,
    channel: flags.channel || flags.c,
    idempotencyKey: flags["idempotency-key"],
    force: !!(flags.force || flags.f || flags.test),
  };
  if (flags.dry) {
    console.log(formatUserNotification(text, opts));
    return;
  }
  const result = await notifyUser(text, opts);
  if (result.deduped) console.log("notifyuser skipped duplicate");
  else console.log(`notifyuser sent → ${result.target}${result.fallback ? " (fallback)" : ""}`);
}

/** Persistent todo list backed by ~/.openclaw/workspace/memory/tasks.md. */
async function cmdTodo(args) {
  const { flags, positional } = parseFlags(args, {
    all: "boolean",
    parked: "boolean",
    blocked: "boolean",
    dry: "boolean",
    path: "string",
  });
  const path = flags.path || DEFAULT_TODOS_PATH;
  const sub = positional[0];

  const printList = (parsed) => {
    console.log(formatActiveList(parsed));
    if (flags.all) {
      const done = listDone(parsed, 20);
      if (done.length) {
        console.log("\n## Klart (senaste)");
        for (const it of done) console.log("  " + formatItemLine(it, { includeCreated: true }));
      }
    }
  };

  // No subcommand → list active (+ done if --all)
  if (!sub) {
    printList(loadTodos(path));
    return;
  }

  switch (sub) {
    case "list":
    case "ls": {
      printList(loadTodos(path));
      return;
    }
    case "add": {
      const text = positional.slice(1).join(" ").trim();
      if (!text) {
        console.error('Usage: amux todo add "text" [--parked|--blocked]');
        process.exit(1);
      }
      const parsed = loadTodos(path);
      const section = flags.parked ? SECTION_PARKED
        : flags.blocked ? SECTION_BLOCKED
        : SECTION_NOW;
      const { item } = addTodo(parsed, text, { section });
      if (flags.dry) {
        console.log(`(dry) would add: ${formatItemLine(item)} → ${section}`);
        return;
      }
      saveTodos(parsed, path);
      console.log(`added: ${formatItemLine(item)} → ${section}`);
      return;
    }
    case "done":
    case "do": {
      const target = positional.slice(1).join(" ").trim();
      if (!target) {
        console.error("Usage: amux todo done <id|substring>");
        process.exit(1);
      }
      const parsed = loadTodos(path);
      const before = findItem(parsed, target);
      if (!before) {
        console.error(`No todo found matching "${target}"`);
        process.exit(1);
      }
      const result = doneTodo(parsed, target);
      if (flags.dry) {
        console.log(`(dry) would close: ${formatItemLine(result.item)} (was in ${result.fromSection})`);
        return;
      }
      saveTodos(parsed, path);
      console.log(`closed: ${formatItemLine(result.item)} (was in ${result.fromSection})`);
      return;
    }
    case "rm":
    case "remove": {
      const target = positional.slice(1).join(" ").trim();
      if (!target) {
        console.error("Usage: amux todo rm <id|substring>");
        process.exit(1);
      }
      const parsed = loadTodos(path);
      const result = rmTodo(parsed, target);
      if (!result.found) {
        console.error(`No todo found matching "${target}"`);
        process.exit(1);
      }
      if (flags.dry) {
        console.log(`(dry) would remove: ${formatItemLine(result.item)}`);
        return;
      }
      saveTodos(parsed, path);
      console.log(`removed: ${formatItemLine(result.item)}`);
      return;
    }
    case "edit": {
      const editor = process.env.EDITOR || "vi";
      const { spawn } = await import("child_process");
      const child = spawn(editor, [path], { stdio: "inherit" });
      await new Promise((resolve) => child.on("close", resolve));
      return;
    }
    case "path": {
      console.log(path);
      return;
    }
    default: {
      console.error(`Unknown todo subcommand: ${sub}`);
      console.error("Usage: amux todo [list|add|done|rm|edit|path] [--all|--parked|--blocked|--dry]");
      process.exit(1);
    }
  }
}

/**
 * Read todos and send a notifyuser push if any active items exist.
 * Intended for cron at 08:00 daily. Idempotent; safe to run repeatedly.
 */
async function cmdTodoRemind(args) {
  const { notifyUser } = await import("./send-notify.mjs");
  const { flags } = parseFlags(args, {
    dry: "boolean",
    path: "string",
    title: "string",
    level: "string",
    force: "boolean",
  });
  const path = flags.path || DEFAULT_TODOS_PATH;
  const parsed = loadTodos(path);
  // Remindable ≠ active: parked/blocked items without a DUE deadline are in
  // the LIST but never in the morning ping — daily nags about "tar tag i
  // senare" become wallpaper and kill the reminder's signal value.
  const active = listRemindable(parsed);
  if (active.length === 0) {
    console.log("No remindable todos — nothing to remind.");
    return;
  }
  const body = formatReminderSummary(parsed);
  const opts = {
    level: flags.level || "info",
    title: flags.title || "amux todos",
    force: !!flags.force,
  };
  if (flags.dry) {
    console.log(`(dry) would notify: ${body}`);
    return;
  }
  const result = await notifyUser(body, opts);
  if (result.deduped) console.log("todo-remind skipped duplicate");
  else console.log(`todo-remind sent → ${result.target}${result.fallback ? " (fallback)" : ""} (${active.length} active)`);
}

/**
 * The 08:00 morning digest: ONE DM with everything waiting on the HUMAN —
 * remindable todos + board tickets in needs_detail + open human-directed
 * asks. Replaces the standalone todo-remind cron entry (todo content is
 * folded in) so the morning never sends two pushes. Silent when the queue
 * is genuinely empty; board read-failures are surfaced loudly instead of
 * reading as an empty queue.
 */
async function cmdMorningDigest(ctx, args) {
  const { notifyUser } = await import("./send-notify.mjs");
  const { readFileSync } = await import("fs");
  const { flags } = parseFlags(args, { dry: "boolean", force: "boolean" });
  const nowMs = Date.now();

  const parsed = loadTodos(process.env.AMUX_TODOS_PATH || DEFAULT_TODOS_PATH);
  const todoSummary = listRemindable(parsed).length ? formatReminderSummary(parsed) : null;

  const confPath = process.env.FLEETS_CONF
    || `${process.env.HOME}/.agentmux/fleet-watch/fleets.conf`;
  const tokenPath = process.env.SUGGEST_READ_TOKEN_FILE
    || `${process.env.HOME}/.config/agent/suggestions-read-token`;
  const boardBase = process.env.SUGGEST_BASE_URL || "https://suggest.v1d.io";
  const boardDecisions = [];
  const boardFailures = [];
  let confText = "";
  try { confText = readFileSync(confPath, "utf-8"); } catch { /* no fleets = no boards */ }
  let readToken = null;
  try { readToken = readFileSync(tokenPath, "utf-8").trim(); } catch { /* surfaced below */ }
  for (const { project } of digestProjects(confText)) {
    if (!readToken) { boardFailures.push(project); continue; }
    try {
      const response = await fetch(`${boardBase}/api/tickets?project=${encodeURIComponent(project)}`, {
        headers: { authorization: `Bearer ${readToken}`, "user-agent": "amux-morning-digest" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) { boardFailures.push(project); continue; }
      const body = await response.json();
      for (const ticket of body.tickets ?? []) {
        if (ticket.status === "needs_detail") {
          boardDecisions.push(boardDecisionItem(project, ticket));
        }
      }
    } catch { boardFailures.push(project); }
  }

  // Open human-directed asks across every claude/codex pane, last 24h.
  // buildAskEntries already applies the SRC-0053 noise + provenance
  // classifiers, so a /compact wrapper or peer-thread question never pages.
  const openAsks = [];
  for (const agent of listAgents(ctx.configPath)) {
    for (let paneIdx = 0; paneIdx < (agent.panes || []).length; paneIdx++) {
      const cmd = agent.panes[paneIdx]?.cmd || "";
      if (!/^(claude|codex)/.test(cmd)) continue;
      const paneDir = panePathFor(agent, paneIdx);
      const res = readLastTurnsForPane(agent, paneIdx, paneDir,
        { limit: 20, tailBytes: 4 * 1024 * 1024 });
      if (!res?.turns?.length) continue;
      const status = await getPaneStatus(ctx, agent.name, paneIdx).catch(() => "unknown");
      const entries = buildAskEntries({ agent: agent.name, pane: paneIdx,
        turns: res.turns, jsonlFile: res.jsonlFile, paneStatus: status, nowMs });
      for (const entry of filterAskEntries(entries,
        { openOnly: true, sinceMs: nowMs - 24 * 3_600_000 })) {
        if (entry.status === "needs-you") openAsks.push(entry);
      }
    }
  }
  openAsks.sort((left, right) => (right.ageMs || 0) - (left.ageMs || 0));

  const message = composeMorningDigest({ todoSummary, boardDecisions, openAsks, boardFailures });
  if (!message) {
    console.log("morning-digest: tom kö — inget skickas.");
    return;
  }
  if (flags.dry) {
    console.log(`(dry) would notify:\n${message}`);
    return;
  }
  const result = await notifyUser(message, { level: "info", title: "Morgondigest",
    force: !!flags.force });
  if (result.deduped) console.log("morning-digest skipped duplicate");
  else console.log(`morning-digest sent → ${result.target} (todos=${todoSummary ? 1 : 0}, board=${boardDecisions.length}, asks=${openAsks.length}, failures=${boardFailures.length})`);
}

/** Compress an "age in minutes" into "Xm" / "Xh" / "Xd" for header chrome. */
function formatRelMin(min) {
  if (!Number.isFinite(min) || min < 0) return "?";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatCommitRow(c) {
  const tsLabel = new Date(c.ts).toISOString().slice(11, 16);
  const labelPad = c.label.padEnd(10).slice(0, 10);
  const hash = c.hash.slice(0, 7);
  const subject = c.subject.length > 70 ? c.subject.slice(0, 69) + "…" : c.subject;
  return `${tsLabel}  ${labelPad}  ${hash}  ${subject}`;
}

/**
 * Render a pane as a compact thread block for `amux done`:
 *
 *   claw:9   12:38  +164t
 *     ← <dir 1> · <dir 2> · <dir 3>      (last ≤3 user directives, oldest→newest)
 *     → <last assistant text>            (where the pane landed)
 *
 * The ← line is the coordination payload: another agent reads it to see what
 * this pane was told to do without a follow-up `amux log`. The → line shows
 * the latest reply. Both lines are omitted when empty so idle-ish rows stay
 * one line. Pass { brief: true } to collapse to the old single-line preview.
 */
function formatDoneRow({ key, bucket, ageMs }, opts = {}) {
  const tsLabel = bucket.latestTurnTs
    ? new Date(bucket.latestTurnTs).toISOString().slice(11, 16)
    : "--:--";
  // Age tag (e.g. "· 3h sen") helps the human spot how long a ball's been
  // dropped / a question's gone unanswered. Only on the actionable sections.
  const ageTag = (opts.showAge && Number.isFinite(ageMs))
    ? `  · ${formatRelMin(Math.round(ageMs / 60000)).replace(" ago", " sen")}`
    : "";
  const head = `${key.padEnd(10)}  ${tsLabel}  +${bucket.turns}t${ageTag}`;

  if (opts.brief) {
    const preview = previewText(bucket.lastAssistantText || bucket.lastUserText, 70);
    return preview ? `${head}  "${preview}"` : head;
  }

  // System-injected user-role events aren't human directives — they're noise
  // on the ← line. Drop them, but only while real directives remain, so a pane
  // whose only recent input was a hint still shows something.
  const rawDirs = bucket.recentUserTexts && bucket.recentUserTexts.length
    ? bucket.recentUserTexts
    : (bucket.lastUserText ? [bucket.lastUserText] : []);
  const realDirs = rawDirs.filter((t) => !isSystemNoiseDirective(t));
  const dirs = (realDirs.length ? realDirs : rawDirs)
    .map((t) => previewText(stripAnsi(t), 48))
    .filter(Boolean);
  const reply = previewText(stripAnsi(bucket.lastAssistantText || ""), 90);

  const lines = [head];
  if (dirs.length) lines.push(`     ← ${dirs.join(" · ")}`);
  if (reply) lines.push(`     → ${reply}`);
  return lines.join("\n");
}

// Pane commands that correspond to a dialect we can read context for.
// Bash/other commands get a blank context cell. Codex CLI shows up as
// "node" in tmux pane_current_command (binary is `node bin/codex.js`),
// so we resolve its dialect via agents.yaml cmd field instead — see
// dialectFor().
const CONTEXT_DIALECT = { claude: "claude", codex: "codex" };

/**
 * Resolve a pane's coding-agent dialect.
 *
 * Direct match via tmux process name catches `claude`. Codex shows up
 * as `node` (because its binary is node-based), so we cross-reference
 * the configured cmd from agents.yaml when the process is generic node
 * or matches no dialect.
 *
 * Returns "claude", "codex", or null for non-agent panes (bash/services).
 */
function dialectFor(agent, pane) {
  const direct = CONTEXT_DIALECT[pane.command];
  if (direct) return direct;
  const cmd = agent?.panes?.[pane.index]?.cmd || "";
  if (/codex/i.test(cmd)) return "codex";
  if (/claude/i.test(cmd)) return "claude";
  return null;
}

/** Gather status + preview + context for one pane. Safe: never throws. */
/**
 * Last readable assistant text for a pane, pulled from jsonl. This is the
 * meaningful "what is this pane saying" line — the tmux tail is usually
 * status-bar residue (`)`, `⏵⏵ bypass permissions…`, a bare shell prompt),
 * which told a reader nothing. Empty string when no jsonl/text is available
 * (shells, fresh panes) so the caller can fall back to the tmux tail.
 */
function lastAssistantPreview(agent, paneIdx, paneDir) {
  try {
    // tailBytes caps the jsonl read at 256KB — more than enough to contain
    // the last assistant turn, even with chunky tool output, on files that
    // can otherwise be 100MB+. Without this the preview read dominates `ps`.
    const res = readLastTurnsForPane(agent, paneIdx, paneDir, { limit: 4, tailBytes: 256 * 1024 });
    const turns = res?.turns || [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const items = turns[i].items || [];
      for (let j = items.length - 1; j >= 0; j--) {
        if (items[j].type === "tool") continue;
        // Collapse whitespace: a multi-line assistant message would otherwise
        // inject blank lines mid-row and shatter the ps grid.
        const c = (items[j].content || "").replace(/\s+/g, " ").trim();
        if (c) return c;
      }
    }
  } catch {}
  return "";
}

// WHAT: Reads one pane's canonical context and preview.
// WHY: Keeps native and tmux engines behind one top-row contract.
async function inspectPane(ctx, agent, pane) {
  if (agent.backend === "native") {
    try {
      const snapshot = await ctx.agent.nativeRuntime.history(agent.name, pane.index);
      const turns = groupNativeTurns(snapshot.events);
      const latest = turns.at(-1);
      const preview = latest?.items?.filter((item) => item.type === "text").at(-1)?.content || "";
      const context = nativeContextReading(snapshot);
      return {
        status: snapshot.agent.running ? "working" : "idle",
        preview: preview.replace(/\s+/g, " ").trim(),
        context,
      };
    } catch {
      return { status: "unknown", preview: "native runtime offline", context: null };
    }
  }
  // Single capture per pane. We used to call getPaneStatus (a 30-line
  // capture-pane) AND capturePane(100) — two round-trips to the SINGLE-
  // THREADED tmux server, which serializes them server-side no matter how
  // parallel the client is. detectPaneStatus only inspects the last ~15
  // lines, so deriving status from the same 100-line capture is identical
  // output for half the tmux calls — the actual lever for `amux ps` latency.
  let content = "";
  try { content = await ctx.agent.capturePane(agent.name, pane.index, 100); }
  catch {}
  // Same scrape+hook merge as getPaneStatus, applied to the one capture we
  // already have. Capture failure (dead pane) stays "unknown" unmerged.
  let status = content
    ? mergeStatus(detectPaneStatus(stripAnsi(content)),
                  latestPaneStatesCached().get(`${agent.name}:${pane.index}`)).status
    : "unknown";
  const lines = stripAnsi(content).split("\n").filter((l) => l.trim());
  const dialect = dialectFor(agent, pane);
  // Use the worktree pane dir, not agent.dir — same fix as cmdLog (399915f).
  // Claude Code stores its session jsonl per-cwd; each pane runs in
  // .agents/N, so getContextFromPane's max-tokens fallback must read from
  // the worktree slug, not the parent project slug.
  const paneDir = panePathFor(agent, pane.index);
  // Cheap tmux-tail preview as a fallback. The meaningful jsonl-based preview
  // is read lazily in the render loop, but ONLY for panes that get expanded
  // (active / has-context) — readLastTurns is a synchronous full-file parse,
  // so reading it for all ~40 panes here would serialize and dwarf the
  // parallel tmux probes. Reserve it for the handful that actually display.
  const preview = (lines[lines.length - 1] || "").trim();
  // Claude: status-bar parser (capture-pane already in `content`).
  // Codex: read directly from codex jsonl (no status-bar equivalent).
  let context = null;
  if (dialect === "claude") {
    context = getContextFromPane(content, paneDir);
  } else if (dialect === "codex") {
    context = getContextPercent(paneDir, "codex");
  }

  // Live-activity overlay: tmux-only detection can't tell an active spinner
  // ("✻ Sautéed for X" still counting up) from a frozen one (post-turn
  // residue) — same shape, same regex match. Cross-check jsonl mtime: a
  // jsonl event written recently means the agent is generating right now,
  // regardless of what the prompt-line looks like. Only override when the
  // tmux-detection said idle/unknown so we don't shadow real permission/
  // menu/resume modals.
  //
  // Window: 60s (matches `amux done`'s isRunningNow default). Earlier
  // values (10s, then 30s) caused visible "pendling" between 💤/🟢 in
  // `amux ps` because Claude regularly pauses 30-50s between assistant
  // text + tool calls + deep thinking; the pane is still working but
  // jsonl mtime falls outside the window.
  if ((dialect === "claude" || dialect === "codex") && (status === "idle" || status === "unknown")) {
    const mtimeMs = dialect === "codex"
      ? latestCodexJsonlMtime(paneDir)
      : latestJsonlMtime(paneDir);
    if (mtimeMs && Date.now() - mtimeMs < 60_000) {
      status = "working";
    }
  }
  return { status, preview, context };
}

// Status priorities for sorting agents — agents with active panes first,
// then panes with claude session state, then plain shells last.
const SHELL_CMDS = /^(bash|zsh|fish|sh|dash)$/;
const ACTIVE_STATUS = (s) => statusTier(s) >= 2;


/**
 * amux doctor — one table over every silent failure mode: dead/hung/stale
 * bridge, broken hooks, dead ledger, unreachable tmux, broken config.
 * Exit code: 0 ok, 1 warnings, 2 failures (cron-friendly).
 */
/**
 * amux search — overview-first search over the configured corpora
 * (agents.yaml `search.roots`). One line per hit; `--show N` expands the
 * Nth hit from the LAST search (results persisted to ~/.agentmux/).
 * Semantic layer joins in when the optional embedding index exists.
 */
async function cmdSearch(ctx, query, flags) {
  if (flags.show != null) {
    const last = loadLastResults();
    if (!last) { console.error("Ingen tidigare sökning att expandera."); process.exit(1); }
    const picks = String(flags.show).split(",").map((n) => parseInt(n, 10)).filter(Boolean);
    for (const n of picks) {
      const hit = last.hits[n - 1];
      if (!hit) { console.error(`#${n} finns inte (senaste sökningen gav ${last.hits.length} träffar).`); continue; }
      console.log(`── #${n} ${hit.path}:${hit.line}  (sökning: "${last.query}")`);
      console.log(expandHit(hit, { context: flags.context ?? 10 }));
      console.log("");
    }
    return;
  }

  if (!query) { console.error('Usage: amux search "term" [--max N] [--source NAME] [--fast] | --show N [--context N] | --reindex'); process.exit(1); }
  const config = loadConfig(ctx.configPath);
  let roots = loadSearchRoots(config);
  if (!roots.length) {
    console.error("Inga sökrötter. Lägg till i agentmux.yaml (KÄLLAN — agents.yaml är genererad och skrivs över):\n  search:\n    roots:\n      - { name: memory, path: ~/pathtill/memory, glob: \"*.md\", weight: 3, semantic: true }\nKör sen: amux label <agent> 0 --clear (eller /sync) för att materialisera.");
    process.exit(1);
  }
  if (flags.source) roots = roots.filter((r) => r.name.includes(flags.source));

  const t0 = Date.now();
  let hits = lexicalSearch(query, roots);

  // Semantic layer: optional. Missing dep/index = lexical-only + one hint.
  if (!flags.fast) {
    try {
      const sem = await import("../core/search-semantic.mjs");
      const semHits = await sem.semanticSearch(query, { k: 8 });
      // The index is global; honor --source here too or filtered searches
      // leak hits from other roots (observed: bibliotek query answered by
      // memory chunks).
      const allowedRoots = new Set(roots.map((r) => r.name));
      const scoped = (semHits || []).filter((h) => allowedRoots.has(h.root));
      if (scoped.length) {
        hits = dedupeByFile([...hits, ...scoped.map((h) => withScore({ ...h, layer: "sem" }))]);
      }
    } catch (err) {
      if (process.env.AMUX_DEBUG) console.error(`semantic layer off: ${err.message}`);
    }
  }

  const max = flags.max ?? 12;
  const top = hits.slice(0, max);
  if (!top.length) { console.log(`0 träffar för "${query}" (${Date.now() - t0}ms)`); return; }
  saveLastResults(query, top);
  console.log(formatHits(top));
  console.log(`\n${top.length}/${hits.length} träffar, ${Date.now() - t0}ms  ·  expandera: amux search --show N`);
}

/**
 * amux revive — post-boot fleet recovery: respawn every configured coding
 * pane (ensureReady is idempotent; running panes untouched) and send a
 * resume-brief to panes whose ledger shows a prompt-without-stop from
 * before boot (= interrupted mid-turn), unless they are already working.
 * --dry prints the plan without acting.
 */
async function cmdRevive(ctx, flags) {
  const bootMs = parseBootMs(readFileSync("/proc/stat", "utf-8"));
  if (!bootMs) { console.error("Kunde inte läsa boot-tid ur /proc/stat."); process.exit(1); }
  console.log(`Boot: ${new Date(bootMs).toLocaleString("sv-SE")}`);

  const agents = listAgents(ctx.configPath);
  const nativeServiceTargets = configuredServiceTargets(ctx)
    .filter((target) => target.backend === "native");
  const panes = [];
  for (const a of agents) {
    (a.panes || []).forEach((p, i) => {
      if (/claude|codex/.test(String(p?.cmd || ""))) {
        panes.push({ agent: a.name, pane: i, cmd: p.cmd, backend: a.backend });
      }
    });
  }

  const statuses = new Map();
  const codexInterruptions = [];
  for (const p of panes) {
    try { statuses.set(`${p.agent}:${p.pane}`, await getPaneStatus(ctx, p.agent, p.pane)); }
    catch { statuses.set(`${p.agent}:${p.pane}`, "unknown"); }
    if (p.backend !== "native" && /codex/.test(String(p.cmd || ""))) {
      try {
        const agent = agents.find((item) => item.name === p.agent);
        const paneDir = join(agent.dir, ".agents", String(p.pane));
        const result = readLastTurnsCodex(paneDir, {
          limit: 4,
          tailBytes: 16 * 1024 * 1024,
          headless: true,
        });
        const interruptedAtMs = codexInterruptionFromTurns(result?.turns || [], bootMs);
        if (interruptedAtMs) codexInterruptions.push({
          agent: p.agent,
          pane: p.pane,
          interruptedAtMs,
        });
      } catch { /* missing/partial rollout: coding-pane recovery still runs */ }
    }
  }

  let events = [];
  try { events = readEvents({ tailBytes: 0 }); } catch { /* empty ledger: respawn still runs */ }
  const plan = planRevive({ events, bootMs, panes, statuses, codexInterruptions });

  console.log(`Paneler: ${panes.length} konfigurerade coding-panes säkras (idempotent).`);
  console.log(`Tjänster: ${nativeServiceTargets.reduce((sum, target) => sum + target.services.length, 0)} native-processer säkras (idempotent).`);
  if (!plan.briefs.length) console.log("Avbrutna mitt i arbete: inga.");
  for (const b of plan.briefs) {
    console.log(`  ⚡ ${b.agent}:${b.pane}  avbruten ${new Date(b.interruptedAtMs).toTimeString().slice(0, 8)} → resume-brief${flags.dry ? " (dry)" : ""}`);
  }
  if (flags.dry) return;

  for (const p of panes) {
    try {
      if (p.backend === "native") await ctx.agent.nativeRuntime.ensureTarget(p.agent, p.pane);
      else await ctx.agent.ensureReady(p.agent, p.pane);
    }
    catch (err) { console.error(`  ensureReady ${p.agent}:${p.pane} misslyckades: ${err.message.split("\n")[0]}`); }
  }
  for (const target of nativeServiceTargets) {
    try { await startNativeServices(target); }
    catch (err) { console.error(`  services ${target.name} misslyckades: ${err.message.split("\n")[0]}`); }
  }
  for (const b of plan.briefs) {
    const sent = await sendToPane(ctx, b.agent, b.pane, reviveBrief(b.interruptedAtMs, bootMs));
    if (!sent?.delivered) {
      console.error(`  INTE skickad: ${b.agent}:${b.pane} (${sent?.blocked ? "parkerad" : "leverans ej verifierad"})`);
      continue;
    }
    try {
      appendEvent({
        ts: new Date().toISOString(),
        event: "revive_brief",
        session: b.agent,
        pane: b.pane,
        interruptedAtMs: b.interruptedAtMs,
        detail: `boot ${new Date(bootMs).toISOString()}`,
      });
    } catch (err) {
      console.error(`  revive receipt ${b.agent}:${b.pane} misslyckades: ${err.message}`);
    }
    console.log(`  skickad: ${b.agent}:${b.pane}`);
  }
  console.log("Revive klar.");
}

async function cmdMemory(_ctx, subcommand, flags = {}) {
  const workspace = flags.workspace || process.env.OPENCLAW_WORKSPACE
    || join(process.env.HOME, ".openclaw", "workspace");
  const {
    lintMemory, formatMemoryLint, formatMemoryStatus, readLatestMemoryCompact,
    writeMemoryDailyReport,
  } = await import("../core/memory-lint.mjs");

  if (subcommand === "status") {
    const result = lintMemory(workspace);
    result.compact = readLatestMemoryCompact(workspace);
    console.log(flags.json ? JSON.stringify(result, null, 2) : formatMemoryStatus(result));
    return;
  }
  if (subcommand === "lint") {
    const result = lintMemory(workspace);
    if (flags.reportDaily) {
      writeMemoryDailyReport(workspace, result, { compacted: Number(flags.compacted) || 0 });
    }
    console.log(flags.json ? JSON.stringify(result, null, 2) : formatMemoryLint(result));
    if (result.summary.warnings > 0) process.exitCode = 1;
    return;
  }
  if (subcommand === "compact") {
    const { compactMemory, formatMemoryCompact } = await import("../core/memory-compact.mjs");
    const result = await compactMemory(workspace, {
      dryRun: !!flags.dry,
      maxFiles: Number.isFinite(flags.max) ? flags.max : undefined,
    });
    console.log(flags.json ? JSON.stringify(result, null, 2) : formatMemoryCompact(result));
    if (result.failed.length > 0) process.exitCode = 1;
    return;
  }

  console.error(`Usage:
  amux memory status [--json] [--workspace PATH]
  amux memory lint [--json] [--report-daily] [--compacted N] [--workspace PATH]
  amux memory compact [--dry] [--json] [--max N] [--workspace PATH]`);
  process.exitCode = 1;
}

function queueAge(createdAt, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - Number(createdAt || now)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function queueDisplayState(job) {
  const state = job.status === "acknowledged" ? "delivered" : String(job.status || "unknown");
  return job.cancelRequestStatus === "requested" ? `${state}+cancel_requested` : state;
}

function queueReason(job) {
  if (job.cancelRequestStatus === "requested") {
    return `cancel requested: ${job.cancelRequestedReason || "reason unavailable"}`;
  }
  return job.lastReason || job.cancelRequestLastReason || "";
}

function queueCell(value, max) {
  const printable = stripAnsi(String(value || ""))
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(printable, max);
}

/** Operational queue truth: unfinished jobs plus terminal receipts still awaiting notice. */
export function listDeliveryQueueJobs(queue, { includeTerminal = false } = {}) {
  const targets = includeTerminal ? queue.allTargets() : queue.targets();
  return targets.flatMap(({ agentName, pane }) => queue.list(agentName, pane))
    .filter((job) => includeTerminal
      || !TERMINAL_DELIVERY_STATES.has(job.status)
      || needsDeliveryTerminalNotice(job)
      || job.cancelRequestStatus === "requested")
    .sort((a, b) => {
      const byCreated = Number(a.createdAt || 0) - Number(b.createdAt || 0);
      return byCreated || String(a.id).localeCompare(String(b.id));
    });
}

export function deliveryQueueDisplayRows(jobs, { now = Date.now() } = {}) {
  return jobs.map((job) => ({
    jobId: String(job.id),
    target: `${job.agentName}:${job.pane}`,
    age: queueAge(job.createdAt, now),
    state: queueDisplayState(job),
    attempts: Number(job.attempts || 0),
    reason: queueCell(queueReason(job), 52),
    preview: queueCell(job.text, 60),
  }));
}

export function formatDeliveryQueueTable(rows, { total = rows.length } = {}) {
  if (!rows.length) return "Delivery queue is empty.";
  const headers = {
    jobId: "jobId",
    target: "target",
    age: "age",
    state: "state",
    attempts: "attempts",
    reason: "reason",
    preview: "preview",
  };
  const keys = Object.keys(headers);
  const widths = Object.fromEntries(keys.map((key) => [
    key,
    Math.max(headers[key].length, ...rows.map((row) => String(row[key]).length)),
  ]));
  const line = (row) => keys.map((key) => String(row[key]).padEnd(widths[key])).join("  ").trimEnd();
  const output = [line(headers), ...rows.map(line)];
  if (total > rows.length) output.push(`… ${total - rows.length} more; raise --limit to show them.`);
  return output.join("\n");
}

/** Durable request only. The delivery broker remains the sole cancellation adjudicator. */
export function requestDeliveryQueueCancellation(queue, { id, reason, requestedBy = "cli" }) {
  const before = queue.findById(id);
  if (!before) throw new Error(`delivery job ${id} not found`);
  const job = queue.requestCancellation(id, { reason, requestedBy });
  const newlyRequested = !before.cancelRequestStatus && job.cancelRequestStatus === "requested";
  return { job, newlyRequested };
}

function cmdQueue(positional, flags, ctx) {
  const queue = ctx.deliveryQueue || createDeliveryQueue();
  if (positional[0] === "cancel") {
    if (!positional[1] || positional.length !== 2 || !String(flags.reason || "").trim()) {
      throw new Error("Usage: amux queue cancel JOB_ID --reason TEXT");
    }
    const requestedBy = ctx.deliveryQueueRequester || detectSenderFromEnv(
      process.env,
      (cmd) => execSync(cmd, { encoding: "utf8", timeout: 2000 }),
    ) || "cli";
    const result = requestDeliveryQueueCancellation(queue, {
      id: positional[1],
      reason: flags.reason,
      requestedBy,
    });
    const response = {
      jobId: result.job.id,
      target: `${result.job.agentName}:${result.job.pane}`,
      deliveryState: result.job.status,
      cancelRequestStatus: result.job.cancelRequestStatus,
      cancelRequestedReason: result.job.cancelRequestedReason,
      newlyRequested: result.newlyRequested,
    };
    if (flags.json) {
      console.log(JSON.stringify(response, null, 2));
    } else if (result.job.cancelRequestStatus === "requested") {
      console.log(`${result.newlyRequested ? "Cancellation requested" : "Cancellation already requested"} for ${result.job.id} (${response.target}).`);
      console.log(`Current delivery state remains '${result.job.status}' until the broker decides; this is not a cancellation receipt.`);
    } else {
      console.log(`Cancellation was already resolved as '${result.job.cancelRequestStatus}' for ${result.job.id} (${response.target}).`);
      if (result.job.cancelRequestLastReason) console.log(result.job.cancelRequestLastReason);
    }
    return;
  }
  if (positional.length) throw new Error("Usage: amux queue [--all] [--limit N] [--json]");

  const limit = flags.limit == null ? 100 : Number(flags.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("--limit must be an integer from 1 to 1000");
  }
  const jobs = listDeliveryQueueJobs(queue, { includeTerminal: !!flags.all });
  const visible = jobs.slice(0, limit);
  const rows = deliveryQueueDisplayRows(visible, {
    now: typeof ctx.now === "function" ? ctx.now() : Date.now(),
  });
  if (flags.json) {
    console.log(JSON.stringify({ total: jobs.length, jobs: rows }, null, 2));
  } else {
    console.log(formatDeliveryQueueTable(rows, { total: jobs.length }));
  }
}

async function cmdPs(ctx, flags = {}) {
  const showAll = flags.full || flags.f;
  const agents = listAgents(ctx.configPath);
  // Mark the calling pane so an agent running `ps` from inside tmux can spot
  // itself ("◀ du") — orientation for a context-less agent.
  const selfKey = detectSelfKey();

  // Step 1: gather all data first so we can sort agents by importance.
  // Every pane is inspected in parallel — each inspectPane is 2+ tmux
  // subprocess spawns (status + capture) plus a jsonl read, and doing all
  // ~40 panes sequentially was the whole reason `amux ps` took ~8s. Agents
  // are probed concurrently too; tmux handles parallel capture fine.
  const live = (await Promise.all(agents.map(async (a) =>
    (await hasSession(ctx, a.name)) ? a : null,
  ))).filter(Boolean);
  const agentData = await Promise.all(live.map(async (a) => {
    const panes = await listPanes(ctx, a.name);
    const enriched = await Promise.all(panes.map(async (p) => ({
      ...p, ...(await inspectPane(ctx, a, p)),
    })));
    return { agent: a, panes: enriched };
  }));

  if (agentData.length === 0) {
    console.log("No running agents.");
    return;
  }

  // Step 2: sort agents by max-importance pane (active > claude-with-context > shells).
  // Stable on max so agents with same tier keep their config order.
  const importance = (ad) => Math.max(0, ...ad.panes.map((p) =>
    ACTIVE_STATUS(p.status) ? 3 :
    (p.context?.percent ?? 0) > 0 ? 2 :
    !SHELL_CMDS.test(p.command) ? 1 : 0,
  ));
  agentData.sort((a, b) => importance(b) - importance(a));

  // Step 3: render with grouping. Idle/unknown panes of the same command
  // collapse into a single line; active panes always shown in full.
  for (const { agent: a, panes } of agentData) {
    // Per-pane dialect comes from the configured cmd (agents.yaml), not
    // the live process name: codex runs as `node bin/codex.js` so tmux
    // reports "node" — same as some transient claude states. Trust the
    // config for classification; it's the authoritative source of truth
    // for which pane is which dialect.
    const isCodexPane = (p) => /codex/i.test(a.panes?.[p.index]?.cmd || "");
    const isClaudePane = (p) => /claude/i.test(a.panes?.[p.index]?.cmd || "");
    const claudeCount = panes.filter(isClaudePane).length;
    const codexCount = panes.filter(isCodexPane).length;
    const shellCount = panes.filter((p) => SHELL_CMDS.test(p.command) && !isClaudePane(p) && !isCodexPane(p)).length;
    const otherCount = panes.length - claudeCount - codexCount - shellCount;
    const summary = [
      claudeCount && `${claudeCount} claude`,
      codexCount && `${codexCount} codex`,
      otherCount && `${otherCount} svc`,
      shellCount && `${shellCount} shell`,
    ].filter(Boolean).join(" · ");

    console.log(`\n● ${a.name.padEnd(12)} ${a.dir}  [${summary}]`);

    // Quick path: agent has zero coding-agent panes (claude or codex)
    // AND none active → "all idle".
    if (!showAll && claudeCount === 0 && codexCount === 0 && !panes.some((p) => ACTIVE_STATUS(p.status))) {
      console.log(`  ⚪ all idle (${panes.length})`);
      continue;
    }

    let i = 0;
    while (i < panes.length) {
      const p = panes[i];
      const expand = showAll
        || ACTIVE_STATUS(p.status)
        || (p.context?.percent ?? 0) > 0;

      if (expand) {
        const icon = statusIcon(p.status);
        const ctxCell = formatContextCell(p.context);
        // "vilken modell kör den?" — the model IS the interesting name of a
        // coding pane; the generic cmd ("codex") only says the harness.
        const modelLabel = p.context?.model
          ? shortModelName(p.context.model) + (p.context.effort ? `·${p.context.effort}` : "")
          : null;
        const cmd = (modelLabel || p.command).padEnd(6);
        const label = a.panes[p.index]?.label;
        // Label wins; otherwise pull the meaningful last-assistant line from
        // jsonl (only now, for this expanded pane). Fall back to the tmux tail.
        let display;
        if (label) {
          display = `[${truncate(label, 40)}]`;
        } else {
          const jsonl = a.backend === "native"
            ? ""
            : lastAssistantPreview(a, p.index, panePathFor(a, p.index));
          display = truncate(jsonl || p.preview, 70);
        }
        const selfTag = selfKey === `${a.name}:${p.index}` ? "  ◀ du" : "";
        console.log(`  ${icon} p${p.index}  ${cmd} ${ctxCell}  ${display}${selfTag}`);
        i++;
        continue;
      }

      // Collapse consecutive same-command + same-status idle/unknown panes.
      const groupCmd = p.command;
      const groupStatus = p.status;
      let j = i;
      while (j < panes.length
             && panes[j].command === groupCmd
             && panes[j].status === groupStatus
             && !ACTIVE_STATUS(panes[j].status)
             && (panes[j].context?.percent ?? 0) === 0) {
        j++;
      }
      const start = panes[i].index;
      const end = panes[j - 1].index;
      const range = j - i === 1 ? `p${start}` : `p${start}-p${end}`;
      const icon = statusIcon(groupStatus);
      console.log(`  ${icon} ${range.padEnd(7)} ${groupCmd.padEnd(6)} ${groupStatus} (${j - i})`);
      i = j;
    }
  }

  console.log("\nStatus: 🟢 working  🔴 needs input/interrupted  🚫 limited  🟡 resume/dismiss  💤 idle/done  ⚪ unknown");
  if (!showAll) console.log("(use --full / -f to expand all panes)");
}

/**
 * Bulk-compact coding-agent panes above a context-percent threshold.
 *
 * Rationale: a parked coding-agent pane at 80% context costs a full re-read
 * of ~800k tokens on every new turn. /compact summarizes history into
 * working memory and drops token count an order of magnitude, while
 * preserving session intent (unlike /clear which nukes it).
 *
 * Defaults skip panes the user is mid-interaction with: working,
 * permission, menu. --force overrides.
 *
 * Statuses we compact by default: idle, unknown (mostly idle or just-spawned).
 */
// Don't bother compacting panes below this absolute token count. Rationale:
// on a 200k-context pane, 20% is only 40k — compacting saves nothing
// meaningful. On a 1M-context pane, 20% is 200k, worth compacting. This
// floor makes the default threshold sensible across both context sizes.
const COMPACT_MIN_TOKENS = 200_000;

async function cmdCompact(ctx, flags = {}, positional = []) {
  // Focus instructions ride the slash command itself: `/compact <focus>` tells
  // the pane WHAT to preserve in the summary (contracts, task-file pointers,
  // current verify state) instead of letting it guess. Orchestrator-supplied,
  // since panes cannot compact themselves.
  const focus = flags.m ?? flags.message ?? "";
  const compactText = focus ? `/compact ${focus}` : "/compact";

  // Targeted mode: `amux compact <agent> [-p N] [-m "preserve ..."]`.
  // A non-numeric first positional is an agent name. An explicit target skips
  // the bulk thresholds (you chose the pane deliberately) but KEEPS the
  // working-pane guard — compacting mid-turn drops in-flight work.
  if (positional[0] != null && Number.isNaN(Number(positional[0]))) {
    return compactOnePane(ctx, String(positional[0]), flags, compactText);
  }

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
      // Coding-agent panes only. Claude shows up as `claude` in tmux;
      // codex shows up as `node` (binary is node-based) so we resolve
      // dialect via dialectFor which cross-references agents.yaml cmd.
      const dialect = dialectFor(a, p);
      if (dialect !== "claude" && dialect !== "codex") continue;
      const { status, context } = await inspectPane(ctx, a, p);
      if (!context) continue;
      if (context.percent < threshold) continue;
      if (context.tokens < minTokens) continue;
      const unsafe = isCompactUnsafe(status);
      if (unsafe && !force) {
        skipped.push({ agent: a.name, pane: p.index, dialect, context, status });
        continue;
      }
      targets.push({ agent: a.name, pane: p.index, dialect, context, status });
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
    console.log(`\nNo claude/codex panes above ${threshold}%. Nothing to do.`);
    return;
  }

  if (dry || !targets.length) return;

  console.log("");
  for (const t of targets) {
    try {
      // Mirror to Discord with an "amux:compact" source tag so channel
      // watchers can tell this was a bulk-compact action vs a manual
      // /compact somebody typed. Transparency without noise.
      const sent = await sendToPane(ctx, t.agent, t.pane, compactText, { source: "amux:compact" });
      if (sent?.delivered) console.log(`✓ ${t.agent} p${t.pane}: ${compactText} sent`);
      else console.log(`✗ ${t.agent} p${t.pane}: ${sent?.blocked ? "blocked by park-guard" : "delivery not acknowledged"}`);
    } catch (err) {
      console.log(`✗ ${t.agent} p${t.pane}: ${err.message}`);
    }
  }
  console.log(`\nNote: /compact runs asynchronously in each pane. Run 'amux top' in a minute to see new values.`);
}

/**
 * Compact ONE explicitly named pane: `amux compact <agent> [-p N] [-m "focus"]`.
 *
 * WHAT: Sends `/compact [focus]` to a single claude/codex pane, with the same
 * Discord mirroring as bulk mode.
 * WHY: Bulk mode is threshold-driven and touches EVERY qualifying pane — but
 * before handing a pane a heavy new brief, the orchestrator wants to compact
 * exactly that pane and steer what the summary preserves. Thresholds don't
 * gate here (the human/orchestrator chose the pane); the working-pane guard
 * still does, because compacting mid-turn drops in-flight work.
 */
async function compactOnePane(ctx, name, flags, compactText) {
  const paneIdx = Number.isFinite(flags.p) ? flags.p : 0;
  const agents = listAgents(ctx.configPath);
  const a = agents.find((x) => x.name === name);
  if (!a) {
    console.error(`Unknown agent '${name}'. Known: ${agents.map((x) => x.name).join(", ")}`);
    process.exit(1);
  }
  if (!(await hasSession(ctx, name))) {
    console.error(`Agent '${name}' has no running session.`);
    process.exit(1);
  }
  const panes = await listPanes(ctx, name);
  const p = panes.find((x) => x.index === paneIdx);
  if (!p) {
    console.error(`No pane ${paneIdx} in '${name}' (panes: ${panes.map((x) => x.index).join(", ")}).`);
    process.exit(1);
  }
  const dialect = dialectFor(a, p);
  if (dialect !== "claude" && dialect !== "codex") {
    console.error(`${name} p${paneIdx} is not a claude/codex pane — /compact would land in a shell.`);
    process.exit(1);
  }
  const { status, context } = await inspectPane(ctx, a, p);
  const ctxStr = context ? `${context.percent}% ${formatTokens(context.tokens)}` : "context unknown";
  if (isCompactUnsafe(status) && !flags.force) {
    console.error(
      `${name} p${paneIdx} is ${status} (${ctxStr}) — compacting mid-turn drops in-flight work. Use --force to override.`
    );
    process.exit(1);
  }
  if (context && context.tokens < COMPACT_MIN_TOKENS) {
    console.log(
      `Note: ${name} p${paneIdx} holds only ${formatTokens(context.tokens)} — little to gain, sending anyway (explicit target).`
    );
  }
  if (flags.dry) {
    console.log(`[dry] ${name} p${paneIdx} (${status}, ${ctxStr}) ← ${compactText}`);
    return;
  }
  const sent = await sendToPane(ctx, name, paneIdx, compactText, { source: "amux:compact" });
  if (!sent?.delivered) {
    console.error(`${name} p${paneIdx}: ${sent?.blocked ? "blocked by park-guard" : "delivery not acknowledged"}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${name} p${paneIdx}: ${compactText} sent  (was ${status}, ${ctxStr})`);
  console.log(`Note: /compact runs asynchronously. Run 'amux top' in a minute to see new values.`);
}

/**
 * Manual drift-guard trigger. Sends a short "re-read your CLAUDE.md"
 * reminder to a pane (or all panes). Complements the bridge's auto poll.
 *
 * Modes:
 *   amux remind <agent> -p N        — one pane, unconditional
 *   amux remind --all               — every claude pane, unconditional
 *   amux remind --stale             — only panes past the turn threshold
 *
 * Updates the shared reminder-state file so the bridge's auto poll sees
 * the new timestamp and won't re-fire for another full threshold-worth
 * of turns.
 */
async function cmdRemind(ctx, flags = {}, positional = []) {
  const { loadReminderState, saveReminderState, parseReminderConfig, formatReminderMessage, cutoffFor } =
    await import("../core/reminder-state.mjs");
  const { countTurnsSince, panePathFor } = await import("../core/jsonl-reader.mjs");
  const { readParkState } = await import("../core/pane-park.mjs");

  const config = parseReminderConfig();
  const threshold = Number.isFinite(flags.threshold) ? flags.threshold : config.turnThreshold;
  const state = loadReminderState(config.statePath);
  const nowMs = Date.now();

  const agents = listAgents(ctx.configPath);

  // Resolve target set from flags/positionals.
  const targets = [];
  if (flags.all || flags.stale) {
    for (const a of agents) {
      const panes = Array.isArray(a.panes) ? a.panes : [];
      for (let i = 0; i < panes.length; i++) {
        // Claude panes have cmd starting with "claude" (name can be
        // claude / claude-2 / claude-3 etc per config convention).
        if (!String(panes[i]?.cmd || "").startsWith("claude")) continue;
        targets.push({ agent: a, paneIdx: i });
      }
    }
  } else {
    if (!positional[0]) {
      console.error(`Usage:
  amux remind <agent> -p <pane>    # one pane
  amux remind --all                # every claude pane
  amux remind --stale              # only panes past threshold (${threshold} turns)`);
      process.exit(1);
    }
    const name = resolveAgent(positional[0], ctx.configPath);
    const a = getAgent(ctx.configPath, name);
    if (!a) { console.error(`Unknown agent '${name}'.`); process.exit(1); }
    const paneIdx = Number.isFinite(flags.p) ? flags.p : 0;
    targets.push({ agent: a, paneIdx });
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const { agent: a, paneIdx } of targets) {
    const paneKey = `${a.name}:${paneIdx}`;
    const paneState = state[paneKey] || { lastReminderTsMs: null, lastCompactTsMs: null };

    let turnCount = 0;
    try {
      const paneDir = panePathFor(a, paneIdx);
      const cutoffMs = cutoffFor(paneState);
      const res = countTurnsSince(paneDir, cutoffMs != null ? new Date(cutoffMs) : null);
      turnCount = res?.count ?? 0;
    } catch {}

    // --stale mode: require turnCount above threshold. Single-pane and
    // --all modes send regardless (explicit user intent).
    if (flags.stale && turnCount < threshold) {
      skipped++;
      continue;
    }

    // Parked panes (model downgrade) are never woken — even the one-sentence
    // summary reply would run on the fallback model.
    if (readParkState(a.name, paneIdx)) {
      skipped++;
      console.log(`⏭ ${paneKey}: parkerad (modell-nedgradering), väcks inte`);
      continue;
    }

    try {
      // sendToPane mirrors to the pane's bound Discord channel automatically
      // via the standard mirror path — same as any other `amux` send. No
      // source tag so the reminder reads the same in Discord as in the pane.
      // reminderCount rotates DRIFT_SECTIONS; the shared state file keeps
      // the rotation continuous between manual remind and the bridge poll.
      const reminderCount = paneState.reminderCount || 0;
      const result = await sendToPane(ctx, a.name, paneIdx, formatReminderMessage(turnCount, reminderCount));
      if (!result?.delivered) {
        console.error(`failed ${paneKey}: ${result?.blocked ? "blocked by park-guard" : "delivery not acknowledged"}`);
        failed++;
        continue;
      }
      state[paneKey] = { ...paneState, lastReminderTsMs: nowMs, reminderCount: reminderCount + 1 };
      sent++;
      console.log(`reminded ${paneKey} (${turnCount} turns)`);
    } catch (err) {
      console.error(`failed ${paneKey}: ${err.message}`);
      failed++;
    }
  }

  try { saveReminderState(state, config.statePath); } catch {}

  const mode = flags.all ? "all" : flags.stale ? "stale" : "one";
  console.log(`\nDone. mode=${mode} sent=${sent} skipped=${skipped} failed=${failed}`);
}

/**
 * Toggle bridge text-to-speech on / off / status / explicit set.
 *
 * Why this exists: the `/tts` slash-command in Discord only fires for
 * messages from the human user (the bridge filters out bot-authored
 * messages — see handlers.mjs). Agents inside panes can't ask the bridge
 * to speak by posting to Discord. This CLI command writes the same
 * persistent state file the bridge already uses, and state.mjs's mtime
 * watcher picks the change up on the bridge's next state.get("tts").
 *
 * STATE_FILE resolution mirrors index.mjs: read .env in the package dir
 * if STATE_FILE isn't already exported. Without this, a `.env` override
 * makes the CLI write to /tmp/ while the bridge reads from ~/.config/.
 */
async function cmdTts(arg) {
  const { createState } = await import("../core/state.mjs");
  const { parseEnv } = await import("../lib.mjs");
  if (!process.env.STATE_FILE) {
    try {
      const vars = parseEnv(readFileSync(resolve(BRIDGE_DIR, ".env"), "utf-8"));
      for (const [k, v] of Object.entries(vars)) {
        if (!process.env[k]) process.env[k] = v;
      }
    } catch {}
  }
  const STATE_FILE = process.env.STATE_FILE || "/tmp/agentmux-state.json";
  const state = createState(STATE_FILE);

  const printStatus = () => {
    const enabled = state.get("tts", false);
    console.log(`tts: ${enabled ? "on" : "off"}`);
  };

  switch ((arg || "toggle").toLowerCase()) {
    case "on":
      state.set("tts", true);
      printStatus();
      return;
    case "off":
      state.set("tts", false);
      printStatus();
      return;
    case "status":
      printStatus();
      return;
    case "toggle":
      state.set("tts", !state.get("tts", false));
      printStatus();
      return;
    default:
      console.error(`Usage: amux tts [on|off|toggle|status]`);
      process.exit(1);
  }
}

/**
 * Toggle / set the thinking-stream flag on the bridge state. Identical
 * shape to [cmdTts]: state lives in /tmp/agentmux-state.json, both
 * bridge and CLI read/write the same file so the toggle propagates
 * without IPC. Bridge re-reads `state.get("thinking")` on every
 * incoming message so changes apply on the next interaction.
 */
async function cmdThinking(arg) {
  const { createState } = await import("../core/state.mjs");
  const { parseEnv } = await import("../lib.mjs");
  if (!process.env.STATE_FILE) {
    try {
      const vars = parseEnv(readFileSync(resolve(BRIDGE_DIR, ".env"), "utf-8"));
      for (const [k, v] of Object.entries(vars)) {
        if (!process.env[k]) process.env[k] = v;
      }
    } catch {}
  }
  const STATE_FILE = process.env.STATE_FILE || "/tmp/agentmux-state.json";
  const state = createState(STATE_FILE);
  const printStatus = () => {
    const enabled = state.get("thinking", true);
    console.log(`thinking: ${enabled ? "on" : "off"}`);
  };
  switch ((arg || "toggle").toLowerCase()) {
    case "on": state.set("thinking", true); printStatus(); return;
    case "off": state.set("thinking", false); printStatus(); return;
    case "status": printStatus(); return;
    case "toggle": state.set("thinking", !state.get("thinking", true)); printStatus(); return;
    default:
      console.error(`Usage: amux thinking [on|off|toggle|status]`);
      process.exit(1);
  }
}

/** Tell the running bridge to reload agentmux.yaml. SIGHUP wired in
 *  bot.mjs already calls reloadConfig(); CLI just shells the kill. */
async function cmdReload() {
  const { existsSync, readFileSync } = await import("fs");
  const PIDFILE = process.env.PIDFILE || "/tmp/agentmux.pid";
  if (!existsSync(PIDFILE)) {
    console.error("bridge not running (no pidfile at " + PIDFILE + ")");
    process.exit(1);
  }
  const pid = Number(readFileSync(PIDFILE, "utf-8").trim());
  try { process.kill(pid, "SIGHUP"); }
  catch (err) {
    console.error(`reload failed: ${err.message}`);
    process.exit(1);
  }
  console.log(`reload signal sent to bridge (pid ${pid})`);
}

/** Restart the bridge. Sends SIGUSR2 (new handler in bot.mjs) which
 *  exits with code 75; start.sh's loop catches that and respawns.
 *  Falls back to SIGTERM if SIGUSR2 isn't wired (older bridge). */
async function cmdRestart({ all = false } = {}) {
  const { existsSync, readFileSync } = await import("fs");
  const PIDFILE = process.env.PIDFILE || "/tmp/agentmux.pid";
  if (!existsSync(PIDFILE)) {
    console.error("bridge not running (no pidfile at " + PIDFILE + ")");
    process.exit(1);
  }
  const pid = Number(readFileSync(PIDFILE, "utf-8").trim());
  if (all) queueFleetRestart({ source: "cli" });
  try { process.kill(pid, "SIGUSR2"); }
  catch (err) {
    // Do not leave a delayed destructive request for some future bridge
    // start when the intended bridge could not receive this restart signal.
    if (all) consumeFleetRestart();
    console.error(`restart failed: ${err.message}`);
    process.exit(1);
  }
  console.log(all
    ? `fleet restart queued via bridge pid ${pid}; all configured tmux sessions will be recreated`
    : `restart signal sent to bridge (pid ${pid}); start.sh loop will respawn`);
}

/**
 * Trigger a Discord channel sync. Default mode signals the running
 * bridge (SIGUSR1 → handlers.triggerSync); the CLI returns immediately
 * after sending. Result lands in Discord as channel deltas + the
 * foreground terminal or the managed bridge log.
 *
 * `--offline` runs the standalone bin/sync.mjs which uses its own
 * Discord client. The bridge MUST be stopped first or the two clients
 * fight over the gateway connection. Managed bridges bounce automatically.
 * A manually owned bridge requires explicit `--detach`, because its original
 * foreground terminal cannot be recreated after shutdown.
 */
async function cmdSync(args) {
  const { flags } = parseFlags(args, { offline: "boolean", detach: "boolean", d: "boolean" });

  if (flags.offline) return cmdSyncOffline({ allowManagedTakeover: Boolean(flags.detach || flags.d) });

  const { existsSync, readFileSync } = await import("fs");
  const PIDFILE = process.env.PIDFILE || "/tmp/agentmux.pid";
  if (!existsSync(PIDFILE)) {
    console.error("bridge not running. start it with `amux serve`, or use `amux sync --offline`.");
    process.exit(1);
  }
  const pid = Number(readFileSync(PIDFILE, "utf-8").trim());
  try { process.kill(pid, "SIGUSR1"); }
  catch (err) {
    console.error(`sync trigger failed: ${err.message}`);
    process.exit(1);
  }
  console.log(`sync triggered on bridge (pid ${pid}). Tail bridge log for progress, or watch Discord channel deltas.`);
}

export function cmdHintsSync(ctx) {
  const summary = syncConfiguredAgentHints(listAgents(ctx.configPath), {
    ensure: ensureAgentHints,
    version: HINTS_VERSION,
  });
  console.log(
    `Hints v${HINTS_VERSION}: ${summary.configuredSessions} sessions / ` +
    `${summary.workspaceRoots} workspaces, ${summary.changedFiles} files updated.`,
  );
  for (const entry of summary.entries.filter((item) => item.changedFiles > 0)) {
    console.log(`  ${entry.agents.join(",")} -> ${entry.rootDir} (${entry.changedFiles} updated)`);
  }
  for (const failure of summary.errors) {
    console.warn(`  ERROR ${failure.rootDir}/${failure.file || "workspace"}: ${failure.error}`);
  }

  const beat = (ctx.readHeartbeat || readHeartbeat)();
  const bridge = assessRunningBridgeHints(beat, {
    currentVersion: HINTS_VERSION,
    pidAlive: (ctx.isPidAlive || isPidAlive)(Number(beat?.pid)),
  });
  if (bridge.warning) console.warn(`WARNING: ${bridge.warning}`);
  if (summary.errors.length) {
    throw new Error(`hints sync failed for ${summary.errors.length} configured path(s)`);
  }
  return { ...summary, bridge };
}

/** Standalone-sync path. Managed ownership is preserved across the bounce;
 *  manual ownership is never stopped without an explicit --detach takeover. */
async function cmdSyncOffline({ allowManagedTakeover = false } = {}) {
  const { existsSync } = await import("fs");
  const { spawnSync } = await import("child_process");
  const PIDFILE = process.env.PIDFILE || "/tmp/agentmux.pid";
  const SYNC_SCRIPT = resolve(BRIDGE_DIR, "bin/sync.mjs");
  const socket = process.env.TMUX_SOCKET || "/tmp/openclaw-claude.sock";
  const configPath = process.env.AGENT_CONFIG || resolve(process.env.HOME, ".config/agent/agents.yaml");
  const bridgeCtx = { ...createTmuxContext(socket, configPath), bridgeDir: BRIDGE_DIR };

  const wasRunning = existsSync(PIDFILE);
  const previousMode = readBridgeMode();
  const bridgePlan = planOfflineSyncBridge({ wasRunning, mode: previousMode, allowManagedTakeover });
  if (bridgePlan.stop) {
    console.log("stopping bridge for offline sync...");
    await cmdUnserve(bridgeCtx).catch(() => {});
    // Give Discord gateway a beat to release the token before reconnecting.
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log("running standalone sync...");
  const r = spawnSync("node", [SYNC_SCRIPT], { stdio: "inherit", env: process.env });
  const syncOk = r.status === 0;

  if (bridgePlan.restartManaged) {
    console.log("restarting bridge...");
    await cmdServe({ detach: true }, bridgeCtx).catch((err) => {
      console.error(`bridge restart failed: ${err.message}. Run \`amux serve\` manually.`);
    });
  }

  if (!syncOk) process.exit(r.status || 1);
}

/**
 * Speak a short string into the calling pane's bound Discord channel
 * via edge-tts + REST file-upload. The CLI alternative to the auto-tts
 * watcher, useful when an agent wants to fire a crafted spoken summary
 * that's distinct from the full written reply.
 *
 * Usage:
 *   amux say "Klart, deploy uppe."         # post to current pane's channel
 *   amux say -c <channelId> "..."           # explicit channel
 *   amux say -p claw:2 "..."                # explicit agent:pane
 *   amux say --voice 'sv-SE-SofieNeural' "..."  # different voice
 *
 * Truncates at 1500 chars to keep the clip under ~90 sec — same cap as
 * the auto-tts watcher, set per the in-car listener brief.
 */
async function cmdSay(args, ctx) {
  const { execSync: execSyncFn } = await import("child_process");
  const { sendFileToChannelId } = await import("./send-notify.mjs");

  // Load .env so DISCORD_TOKEN/STATE_FILE/etc resolve like the bridge does.
  const { parseEnv } = await import("../lib.mjs");
  try {
    const vars = parseEnv(readFileSync(resolve(BRIDGE_DIR, ".env"), "utf-8"));
    for (const [k, v] of Object.entries(vars)) {
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {}

  const { flags, positional } = parseFlags(args, {
    c: "string", channel: "string",
    p: "string", pane: "string",
    voice: "string", v: "string",
  });
  const text = positional.join(" ").trim();
  if (!text) {
    console.error(`Usage: amux say "text" [-c <channelId>] [-p <agent>:<pane>] [--voice <name>]`);
    process.exit(1);
  }

  // Resolve channel
  let channelId = flags.c || flags.channel;
  if (!channelId) {
    const paneArg = flags.p || flags.pane;
    if (paneArg) {
      const m = paneArg.match(/^([^:]+):(\d+)$/);
      if (!m) { console.error(`-p must be agent:pane, got '${paneArg}'`); process.exit(1); }
      channelId = findChannelForPane(ctx.configPath, m[1], Number(m[2]));
      if (!channelId) { console.error(`No Discord channel bound to ${paneArg}`); process.exit(1); }
    } else {
      // Use sender pane (the one whose tmux env we inherited)
      const { detectSenderFromEnv } = await import("../core/sender-detect.mjs");
      const sender = detectSenderFromEnv(process.env, (cmd) => execSyncFn(cmd, { encoding: "utf-8" }));
      if (!sender) {
        console.error(`No sender detected — pass -c <channelId> or -p <agent>:<pane>`);
        process.exit(1);
      }
      const [agent, paneIdx] = sender.split(":");
      channelId = findChannelForPane(ctx.configPath, agent, Number(paneIdx));
      if (!channelId) { console.error(`No Discord channel bound to ${sender}`); process.exit(1); }
    }
  }

  // Generate TTS — match the bridge's edge-tts call shape.
  const voice = flags.voice || flags.v || process.env.TTS_VOICE || "sv-SE-MattiasNeural";
  const clean = text.replace(/[`*_~|]/g, "").slice(0, 1500);
  const ttsPath = `/tmp/amux-say-${Date.now()}.mp3`;
  try {
    execSyncFn(
      `edge-tts --voice '${voice}' --text '${esc(clean)}' --write-media '${ttsPath}'`,
      { timeout: 30000, stdio: ["ignore", "ignore", "pipe"] }
    );
  } catch (err) {
    console.error(`edge-tts failed: ${err.message}`);
    process.exit(1);
  }

  // Post the text alongside the mp3 so Discord shows a readable summary
  // — tool calls get truncated, but a plain message body doesn't.
  await sendFileToChannelId(channelId, ttsPath, clean);
  console.log(`spoken (${clean.length} chars) → ${channelId}`);

  // Cleanup the local mp3 — Discord has it now.
  try { (await import("fs")).unlinkSync(ttsPath); } catch {}
}

/**
 * Post a local image file to the calling pane's Discord channel.
 * Mirrors the `amux say` channel-resolution rules so an agent can send
 * screenshot proof or visual debug artifacts directly to the human.
 */
async function cmdImage(args, ctx) {
  const { execSync: execSyncFn } = await import("child_process");
  const { sendFileToChannelId } = await import("./send-notify.mjs");
  const { parseEnv } = await import("../lib.mjs");
  try {
    const vars = parseEnv(readFileSync(resolve(BRIDGE_DIR, ".env"), "utf-8"));
    for (const [k, v] of Object.entries(vars)) {
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {}

  const { flags, positional } = parseFlags(args, {
    c: "string", channel: "string",
    p: "string", pane: "string",
    dry: "boolean",
  });

  const filePath = positional[0];
  const caption = positional.slice(1).join(" ").trim();
  if (!filePath) {
    console.error(`Usage: amux image <path> [caption] [-c <channelId>] [-p <agent>:<pane>] [--dry]`);
    process.exit(1);
  }
  if (!existsSync(filePath)) {
    console.error(`image file not found: ${filePath}`);
    process.exit(1);
  }
  // Same contract as inline [image:] markers: fail HERE with a clear reason
  // instead of a raw Discord 400 after the upload attempt.
  const valid = validateImagePath(resolve(filePath), statSync);
  if (!valid.ok) {
    console.error(`image rejected: ${valid.error}`);
    process.exit(1);
  }

  let channelId = flags.c || flags.channel;
  if (!channelId) {
    const paneArg = flags.p || flags.pane;
    if (paneArg) {
      const m = paneArg.match(/^([^:]+):(\d+)$/);
      if (!m) { console.error(`-p must be agent:pane, got '${paneArg}'`); process.exit(1); }
      channelId = findChannelForPane(ctx.configPath, m[1], Number(m[2]));
      if (!channelId) { console.error(`No Discord channel bound to ${paneArg}`); process.exit(1); }
    } else {
      const sender = detectSenderFromEnv(process.env, (cmd) => execSyncFn(cmd, { encoding: "utf8", timeout: 2000 }));
      if (!sender) {
        console.error(`No sender detected — pass -c <channelId> or -p <agent>:<pane>`);
        process.exit(1);
      }
      const [agent, paneIdx] = sender.split(":");
      channelId = findChannelForPane(ctx.configPath, agent, Number(paneIdx));
      if (!channelId) { console.error(`No Discord channel bound to ${sender}`); process.exit(1); }
    }
  }

  if (flags.dry) {
    const name = filePath.split("/").pop() || filePath;
    console.log(`image: ${name} → ${channelId}${caption ? ` (${caption})` : ""}`);
    return;
  }

  await sendFileToChannelId(channelId, filePath, caption);
  const name = filePath.split("/").pop() || filePath;
  console.log(`image (${name}) → ${channelId}${caption ? " with caption" : ""}`);
}

/**
 * WHAT: Prints the fleet context leaderboard or its canonical JSON snapshot.
 * WHY: Keeps human and machine consumers on the same context observations.
 * Cross-session context leaderboard. Sorts all claude/codex panes by
 * percent descending (tokens as tie-breaker). Helps answer "which pane
 * is closest to the context ceiling right now?" without manual digging.
 */
async function cmdTop(ctx, flags = {}) {
  const rows = await collectContextTelemetry(ctx, { agents: listAgents(ctx.configPath),
    hasSession, listPanes, dialectFor, inspectPane });

  if (flags.json) {
    console.log(JSON.stringify(contextTelemetrySnapshot(rows)));
    return;
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
  const pane = flags.p ?? 0;
  // `esc` predates composer-control and remains valid for native-runtime
  // targets. Pager inspection and the tmux provenance fence apply only to
  // fallback panes; native delivery keeps its existing adapter-owned path.
  if (ctx.agent?.isNativeTarget?.(name, pane)) {
    await ctx.agent.sendEscape(name, pane);
    console.log(`Sent Escape to '${name}' (pane ${pane}).`);
    return;
  }
  const receipt = await escapePaneComposer(ctx, name, pane, { actor: detectSelfKey() });
  console.log(receipt.pager
    ? `Closed transcript pager in '${name}' (pane ${pane}) [${receipt.controlId}].`
    : `Sent Escape to '${name}' (pane ${pane}) [${receipt.controlId}].`);
}

async function cmdKeys(name, keys, flags, ctx) {
  const pane = flags.p ?? 0;
  const receipt = await sendComposerKeys(ctx, name, pane, keys, { actor: detectSelfKey() });
  console.log(`Sent ${receipt.keys.join(" ")} to '${name}' (pane ${pane}) [${receipt.controlId}].`);
}

async function cmdEnter(name, flags, ctx) {
  const pane = flags.p ?? 0;
  const receipt = await sendComposerKeys(ctx, name, pane, ["Enter"], {
    action: "enter",
    actor: detectSelfKey(),
  });
  console.log(`Sent Enter to '${name}' (pane ${pane}) [${receipt.controlId}].`);
}

async function cmdClearline(name, flags, ctx) {
  const pane = flags.p ?? 0;
  const receipt = await clearPaneComposer(ctx, name, pane, { actor: detectSelfKey() });
  console.log(`Cleared composer in '${name}' (pane ${pane}) [${receipt.controlId}].`);
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

async function cmdLint(args, ctx) {
  const { flags, positional } = parseFlags(args, FLAG_SPECS.lint);
  if (flags.help || flags.h) {
    console.log(`Usage: amux lint [target...] [--all-agents] [--changed] [--strict]

Targets:
  (none)                    Current working directory
  . / path [path...]        One or more file/dir paths (scoped multi-root scan)
  <agent>                   Agent name from agentmux config

Options:
  --all-agents              Lint every configured agent directory
  --changed                 Only files changed relative to HEAD
  --strict                  Exit non-zero when active error/debt findings exist
  --baseline <path>         Suppress findings already recorded in baseline
  --update-baseline         Write current findings to baseline
  --only contract           Run only one check (currently: contract)
  --skip contract           Skip one check
  --limit N                 Findings per root to print (default: 80)`);
    return;
  }

  const only = flags.only ? String(flags.only) : null;
  const skip = flags.skip ? new Set(String(flags.skip).split(",").map((s) => s.trim()).filter(Boolean)) : new Set();
  if ((only && only !== CONTRACT_CHECK_ID) || skip.has(CONTRACT_CHECK_ID)) {
    console.log("amux lint\nNo checks enabled.");
    return;
  }

  let roots;
  if (flags["all-agents"]) {
    roots = listAgents(ctx.configPath).map((agent) => agent.dir);
  } else if (positional.length === 0) {
    roots = [process.cwd()];
  } else {
    // Multiple targets lint as multiple roots under one combined baseline, so a
    // repo can scope to its real source trees (e.g. `src/ai_tools ui/src`) instead
    // of scanning the whole repo or keeping a separate baseline per directory.
    roots = positional.map((target) => {
      const pathTarget = resolvePathTarget(target, process.cwd());
      return existsSync(pathTarget) ? pathTarget : getAgent(ctx.configPath, target).dir;
    });
  }

  if (!roots.length) {
    console.log("amux lint\nNo roots to scan.");
    return;
  }

  let baselinePath = flags.baseline ? resolvePathTarget(flags.baseline, process.cwd()) : null;
  if (flags["update-baseline"] && !baselinePath) {
    if (roots.length !== 1) {
      console.error("amux lint: --update-baseline needs an explicit --baseline <path> when linting multiple roots (or --all-agents)");
      process.exit(1);
    }
    baselinePath = join(roots[0], ".amux-lint-baseline.json");
  }

  const results = lintRoots(roots, {
    changed: !!flags.changed,
    baselinePath,
    updateBaseline: !!flags["update-baseline"],
  });
  if (flags["update-baseline"] && baselinePath) {
    console.log(`Updated baseline: ${baselinePath}\n`);
  }
  console.log(formatLintReport(results, {
    baselinePath,
    limit: flags.limit || 80,
  }));

  const blocking = results.reduce(
    (n, result) => n + result.activeFindings.filter((f) => f.sev !== "warn").length,
    0,
  );
  if (flags.strict && blocking > 0) process.exit(1);
}

/** WHAT: Makes one checkout's tracked npm/uv roots runnable. WHY: Fresh worktrees have no ignored deps. */
export function cmdWorktreeDeps(args) {
  const { flags, positional } = parseFlags(args, FLAG_SPECS["worktree-deps"]);
  if (positional.length > 1) throw new Error("Usage: amux worktree-deps [path] [--check|--dry]");
  if (flags.check && flags.dry) throw new Error("--check and --dry are mutually exclusive");
  const result = provisionWorktreeDependencies({
    root: positional[0] || process.cwd(),
    check: !!flags.check,
    dryRun: !!flags.dry,
  });
  console.log(formatWorktreeDeps(result));
  if (!result.ok && !result.planned) process.exitCode = 1;
  return result;
}

/** WHAT: Bootstraps then runs the repo-owned full gate. WHY: A green claim cannot hide missing ecosystems. */
export function cmdScopedGate(args) {
  const separator = args.indexOf("--");
  const ownArgs = separator === -1 ? args : args.slice(0, separator);
  const explicitCommand = separator === -1 ? [] : args.slice(separator + 1);
  const { flags, positional } = parseFlags(ownArgs, FLAG_SPECS.gate);
  if (!flags.scoped || positional.length > 1 || (separator !== -1 && !explicitCommand.length)) {
    throw new Error("Usage: amux gate --scoped [path] [--dry] [-- command ...]");
  }
  const result = runScopedGate({
    root: positional[0] || process.cwd(),
    explicitCommand,
    dryRun: !!flags.dry,
  });
  console.log(formatWorktreeDeps(result.dependencies));
  if (!result.gate) console.log("Gate: SKIPPED · no repo-owned full gate found");
  else console.log(`Gate: ${result.status.toUpperCase()} · ${result.gate.command} ${result.gate.args.join(" ")} (${result.gate.source})`);
  if (result.locksUnchanged === false) console.log("Gate: RED · a dependency lock changed during the gate");
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
  return result;
}

function cmdHelp() {
  console.log(`agent - Manage Claude Code/Codex tmux sessions

Usage:
  agent                           List agents (● = running)
  agent <name|:nr>                Attach to agent session
  agent <name|:nr> "prompt"       Send prompt to agent
    -n <channel>                  Notify Discord channel when done
    -m <session>                  Message OpenClaw session when done
    --notify-user                 Mobile-push the human when done/problem
    -p <pane>                     Target specific pane (default: 0)
    -q                            Quiet (no confirmation output)
    --stdin                       Read a bounded prompt from stdin (automation)
    --idempotency-key <key>       Reuse one durable queue identity on retry
    --wait-ms <0-12000>           Bound automation receipt wait (enqueue is already durable)
  agent add <name> <dir>          Add new agent
  agent rm <name|:nr>             Remove agent
  agent stop <name|:nr>           Stop tmux session (keep config)
  agent reconcile <name|:nr>      Respawn dead service/shell panes to match config
                                  (preserves live coding-agent panes — use instead of stop+start
                                   when only services died)
  agent serve                     Run Discord bridge here; Ctrl+C stops it
    --detach, -d                  Run under a managed tmux-free supervisor
  agent stop                      Stop Discord bridge (no arg = bridge)
  agent stop --all                Stop bridge + all agent sessions
  agent runtime status            Every managed native runtime + engine health
  agent runtime start             Start native runtime detached (no tmux)
  agent runtime stop              Stop it only while idle (sessions persist)
  agent runtime restart           Controlled idle restart
    --port N                      Select one runtime (start/stop default 8811)
    --data-dir PATH               Registry/uploads directory
    --state-dir PATH              PID/log ownership directory
    --no-legacy-migration         Do not import checkout-local spike history
    --force                       Permit stopping active turns
  agent services status [name]    Native service process ownership + logs
  agent services start [name]     Start configured native services without tmux
  agent services stop [name]      Stop only ownership-verified process groups
  agent cutover <name...>         Dry-run exact-session tmux → native migration
    --all                         Target every remaining tmux agent group
    --runtime URL                 Loopback native runtime (default 127.0.0.1:8811)
    --apply                       Execute only after two idle/queue/session proofs
    --drop-services               Explicitly discard configured service panes
    --manage-services             Move service panes to the tmux-free supervisor
    --drop-shells                 Explicitly discard configured shell panes
    --allow-empty                 Fresh sessions only for proven-empty panes
    --rollback RECEIPT            Byte-exact config restore + tmux restart
  agent log <name|:nr> [-n N]     Show agent output (default: last 3 turns from jsonl)
    -n N                          Number of turns (jsonl) or lines (--tmux)
    -p <pane>                     Target pane
    --since T                     jsonl: only turns at/after T (ISO or '30min')
    --grep PAT                    jsonl: only turns matching regex PAT (case-insensitive)
    --tmux [-s N]                 Raw tmux capture, scrollback depth N (default 200)
    --full                        Both jsonl history AND current tmux state
    --text                        [legacy] Filtered tmux extract (pre-jsonl default)
  agent wait <name|:nr> [-t S]    Wait until agent is ready
  agent select <name|:nr> [-p N] <N> Select menu option N
  agent keys <name|:nr> [-p N] <key...>
                                  Send only Escape,C-a,C-k,C-u,Enter
  agent enter <name|:nr> [-p N]   Submit the current composer with Enter
  agent clearline <name|:nr> [-p N]
                                  Clear composer with Escape,C-a,C-k
  agent esc <name|:nr> [-p N]     Escape, or close a detected Codex pager
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
  agent asks [-n N]               Recent human asks/directives with status + jsonl location
    --open                        Only open-ish asks (open/working/partial/needs-you)
    --since T                     Window (default 7d; ISO or '30min')
    --agent NAME --pane N         Filter to one pane
    --grep PAT                    Regex filter over ask/reply text
    --full                        Exact older scan (slower); default is bounded tail
  agent edit                      Open agentmux.yaml in $EDITOR (source config)
  agent label <agent> <pane> <text> Set per-pane label (shown in amux ps/top)
    --clear                       Remove the label instead of setting one
                                  (note: rewriting agentmux.yaml via label
                                   may drop comments; use 'amux edit' to preserve)
  agent labels [agent]            Show labels table, optionally filtered to one agent
  agent lint [target]             Run default repo linters (WHAT/WHY/DTO contracts)
    --all-agents                  Lint every configured agent directory
    --changed                     Only changed files
    --strict                      Exit non-zero on active error/debt findings
    --baseline <path>             Suppress baseline findings\n    --update-baseline             Write current findings to baseline
  agent churn [path]              WARN-only young tests + rewrite hotspots from git history
  agent worktree-deps [path]      Provision every tracked npm/uv root in a worktree
    --check                       Verify only; fail on missing, stale, or unsafe deps
    --dry                         Show the immutable-copy/local-venv plan
  agent gate --scoped [path]      Bootstrap deps, run the repo-owned full gate, report skips
    --dry                         Show dependency + gate plan without changing anything
    -- command ...                Override gate discovery with an explicit argv-safe command\n  agent proof --config FILE [--output FILE]  Run a clean red-first measurement
  agent compact [threshold=20]    Bulk: /compact to idle claude/codex panes ≥ threshold%
  agent compact <agent> [-p N]    Target ONE pane (skips thresholds, keeps working-guard)
    -m "focus"                    Steer the summary: sends '/compact <focus>' (what to preserve)
                                  Also requires ≥200k tokens absolute (--min-tokens N to change)
    --dry                         Show what would compact, do nothing
    --force                       Include 'working' panes (default: skip)
  agent dream                     Write/update nightly pane digest in workspace memory
    --since T                     Window to summarize (default: 24h)
    --dry                         Preview pane work, do nothing
  agent janitor                   Delete dead session jsonl older than 14d (also runs nightly in dream)\n  agent doctor                    Health check: bridge, Suggestions board/sync, hooks, ledger, tmux (exit 0/1/2)\n  agent revive                    Post-boot: respawn all panes + resume-brief those interrupted mid-turn (--dry to preview)\n  agent memory status             Memory warnings, compact backlog, latest dream
  agent queue                     List live durable delivery jobs (id, target, age, state, attempts, reason, preview)
    --all                         Include terminal delivery history retained on disk
    --limit N                     Maximum rows (default 100, max 1000)
    --json                        Machine-readable output
  agent queue cancel JOB_ID --reason TEXT
                                  Request pre-submit cancellation; broker decides safely
  agent memory lint               Structured memory lint (--json, exit 1 on warnings)
  agent memory compact            Bank + compact oldest daily files (--dry, --max N)
  agent search "term"             Search configured corpora (memory/sessions/ledger); --show N expands, --reindex rebuilds semantic index
    --dry                         List deletion candidates, change nothing
    --days N                      Retention window (default: 14)
  agent playwright-reap           Reap stale Playwright-MCP/browser processes
    --dry                         List process candidates, change nothing
    --minutes N                   Stale age threshold (default: 60)
  agent notifyuser "message"      High-signal mobile notification to the human
    --level info|done|warn|error  Notification level (default: info)
    --idempotency-key <key>       Use a stable Discord nonce for crash-safe retry
    --test                        Send a test notification
  agent image <path> [caption]    Send a local image file to the bound Discord channel
    -c <channelId>                Explicit Discord channel ID
    -p <agent>:<pane>             Explicit agent:pane channel mapping
    --dry                         Print target without posting
  agent quota                     Shared account quota: Claude session/week/Fable + Codex week
  agent r                         Resume last agent
  agent help                      Show this message

Bridge controls (talk to the running bridge):
  agent sync                      Trigger Discord channel sync from agentmux.yaml
    --offline [--detach]          Standalone sync; managed bounce or explicit manual→managed takeover
                                  (slower; use when bridge is wedged or absent)
  agent hints-sync                Refresh generated CLAUDE.md/AGENTS.md in every configured workspace
  agent reload                    Reload agents.yaml without restarting (SIGHUP)
  agent restart                   Restart bridge (SIGUSR2 → exit 75 → start.sh respawn)
    --all                         Recreate every configured tmux session, then restart bridge
  agent thinking [on|off|toggle|status]
                                  Real-time text streaming flag (default on)
  agent tts [on|off|toggle|status]
                                  Text-to-speech flag

Config: ~/.config/agent/agents.yaml
Socket: /tmp/openclaw-claude.sock`);
}

// --- Dispatch ---

const FLAG_SPECS = {
  send: { n: "string", m: "string", p: "number", t: "number", q: "boolean", quiet: "boolean", "notify-user": "boolean", "notify-me": "boolean", force: "boolean", stdin: "boolean", "idempotency-key": "string", "wait-ms": "number" },
  runtime: { port: "number", "data-dir": "string", "state-dir": "string", "no-legacy-migration": "boolean", force: "boolean" },
  services: { force: "boolean" },
  cutover: {
    all: "boolean",
    runtime: "string",
    apply: "boolean",
    dry: "boolean",
    "drop-services": "boolean",
    "manage-services": "boolean",
    "drop-shells": "boolean",
    "allow-empty": "boolean",
    rollback: "string",
  },
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
  top: { n: "number", sort: "string", json: "boolean" },
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
    day: "boolean",
    week: "boolean",
    all: "boolean",
  },
  watch: {
    agent: "string",
    pane: "number",
    grep: "string",
  },
  asks: {
    n: "number",
    agent: "string",
    pane: "number",
    p: "number",
    since: "string",
    grep: "string",
    open: "boolean",
    full: "boolean",
    all: "boolean",
    "per-pane": "number",
  },
  compact: { dry: "boolean", force: "boolean", "min-tokens": "number", p: "number", m: "string", message: "string" },
  dream: {
    since: "string", workspace: "string", dry: "boolean", q: "boolean", quiet: "boolean",
    retry: "boolean", "defer-sentinel": "boolean", deferSentinel: "boolean",
  },
  janitor: { dry: "boolean", days: "number" },
  "playwright-reap": { dry: "boolean", minutes: "number" },
  notifyuser: { level: "string", l: "string", title: "string", user: "string", u: "string", channel: "string", c: "string", force: "boolean", f: "boolean", dry: "boolean", test: "boolean", "idempotency-key": "string" },
  remind: {
    p: "number",                      // pane index (only when single agent given)
    all: "boolean",                   // broadcast to every claude pane
    stale: "boolean",                 // only panes currently over threshold
    threshold: "number",              // override turn threshold for this run
  },
  label: { clear: "boolean" },
  labels: {},
  queue: { all: "boolean", limit: "number", json: "boolean", reason: "string" },
  lint: {
    "all-agents": "boolean",
    changed: "boolean",
    strict: "boolean",
    baseline: "string",
    "update-baseline": "boolean",
    only: "string",
    skip: "string",
    limit: "number",
    help: "boolean",
    h: "boolean",
  },
  "worktree-deps": { check: "boolean", dry: "boolean" },
  gate: { scoped: "boolean", dry: "boolean" }, proof: { config: "string", output: "string" },
  edit: {},
  select: { p: "number" },
  keys: { p: "number" },
  enter: { p: "number" },
  clearline: { p: "number" },
  esc: { p: "number" },
  topic: { p: "number" },
  todo: { all: "boolean", parked: "boolean", blocked: "boolean", dry: "boolean", path: "string" },
  "todo-remind": { dry: "boolean", path: "string", title: "string", level: "string", force: "boolean" },
  "morning-digest": { dry: "boolean", force: "boolean" },
};

/**
 * WHAT: Routes a configured agent named `watch` separately from the live-timeline
 * subcommand of the same name.
 * WHY: Keeps agent delivery from silently starting the live-timeline follower.
 *
 */
export function shouldRouteWatchToAgent(rest, configPath) {
  const commandArgs = parseFlags(rest, FLAG_SPECS.watch);
  const sendArgs = parseFlags(rest, FLAG_SPECS.send);
  if (commandArgs.positional.length === 0
      || (sendArgs.positional.length === 0 && !sendArgs.flags.stdin)) return false;
  try {
    return resolveAgent("watch", configPath) === "watch";
  } catch {
    return false;
  }
}

async function dispatchAgentTarget(name, rest, ctx) {
  const resolved = resolveAgent(name, ctx.configPath);
  const { flags, positional } = parseFlags(rest, FLAG_SPECS.send);

  if (flags.stdin && positional.length > 0) {
    throw new Error("--stdin cannot be combined with a positional prompt");
  }
  if (positional.length > 0 || flags.stdin) {
    const prompt = flags.stdin ? await readPromptFromStdin() : positional.join(" ");
    await cmdSend(resolved, prompt, flags, ctx);

    const notifyUserFlag = !!(flags["notify-user"] || flags["notify-me"]);
    if (flags.n || flags.m || notifyUserFlag) {
      const { notifyWorker } = await import("./notify.mjs");
      const pane = flags.p || 0;
      notifyWorker({ name: resolved, pane, timeout: flags.t || 600,
        notifyChannel: flags.n, msgSession: flags.m, notifyUser: notifyUserFlag,
        prompt, agent: ctx.agent }).catch(() => {});
      console.log(`🔔 Will notify when '${resolved}' is done.`);
    }
  } else {
    await cmdAttach(resolved, ctx);
  }
}

/** WHAT: Dispatches parsed CLI arguments to one command handler. WHY: Keeps command routing separate from process startup and error reporting. */
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
      // No arg, or 'serve'/'bridge' → stop the bridge in either ownership mode.
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
      const { flags } = parseFlags(rest, {
        fg: "boolean", f: "boolean", foreground: "boolean",
        detach: "boolean", d: "boolean",
      });
      return cmdServe(flags, ctx);
    }

    case "runtime":
      return cmdRuntime(rest, ctx);

    case "services":
      return cmdServices(rest, ctx);

    case "cutover":
      return cmdCutover(rest, ctx);

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

    case "ps": {
      const { flags } = parseFlags(rest, { full: "boolean", f: "boolean" });
      return cmdPs(ctx, flags);
    }

    case "doctor": {
      return cmdDoctor(ctx);
    }

    case "quota": {
      const { readQuotaSnapshot } = await import("../core/quota-usage.mjs");
      const { formatQuotaSnapshot } = await import("../core/quota-format.mjs");
      console.log(formatQuotaSnapshot(await readQuotaSnapshot()));
      return;
    }

    case "queue": {
      const { flags, positional } = parseFlags(rest, FLAG_SPECS.queue);
      return cmdQueue(positional, flags, ctx);
    }

    case "revive": {
      const { flags } = parseFlags(rest, { dry: "boolean" });
      return cmdRevive(ctx, flags);
    }

    case "memory": {
      const subcommand = rest[0] || "status";
      const { flags } = parseFlags(rest.slice(1), {
        dry: "boolean", json: "boolean", max: "number", workspace: "string",
        reportDaily: "boolean", "report-daily": "boolean", compacted: "number",
      });
      if (flags["report-daily"]) flags.reportDaily = true;
      return cmdMemory(ctx, subcommand, flags);
    }

    case "search": {
      const { flags, positional } = parseFlags(rest, {
        max: "number", show: "string", context: "number",
        source: "string", fast: "boolean", reindex: "boolean",
      });
      if (flags.reindex) {
        const sem = await import("../core/search-semantic.mjs");
        return sem.reindex(loadSearchRoots(loadConfig(ctx.configPath)), { log: console.log });
      }
      return cmdSearch(ctx, positional.join(" "), flags);
    }

    case "top": {
      const { flags } = parseFlags(rest, FLAG_SPECS.top);
      return cmdTop(ctx, flags);
    }

    case "timeline": {
      const { flags } = parseFlags(rest, FLAG_SPECS.timeline);
      return cmdTimeline(ctx, flags);
    }

    case "watch": {
      if (shouldRouteWatchToAgent(rest, ctx.configPath)) {
        return dispatchAgentTarget("watch", rest, ctx);
      }
      const { flags } = parseFlags(rest, FLAG_SPECS.watch);
      return cmdWatch(ctx, flags);
    }

    case "asks":
    case "ask":
    case "questions": {
      const { flags, positional } = parseFlags(rest, FLAG_SPECS.asks);
      return cmdAsks(ctx, flags, positional);
    }

    case "done": {
      const { flags } = parseFlags(rest, FLAG_SPECS.done);
      return cmdDone(ctx, flags);
    }

    case "compact": {
      const { flags, positional } = parseFlags(rest, FLAG_SPECS.compact);
      return cmdCompact(ctx, flags, positional);
    }

    case "dream": {
      const { flags } = parseFlags(rest, FLAG_SPECS.dream);
      return cmdDream(ctx, flags, { getStatus: getPaneStatus, getLivePanes: listPanes });
    }

    case "janitor": {
      // Manual entry point for the housekeeping that also runs nightly inside
      // `amux dream`. Mainly useful for `--dry` inspection / one-off reclaim.
      const { flags } = parseFlags(rest, FLAG_SPECS.janitor);
      const r = pruneOldSessions({
        dryRun: !!flags.dry,
        ...(flags.days ? { retentionDays: flags.days } : {}),
      });
      console.log(formatJanitorResult(r));
      for (const e of r.errors) console.warn(`  ! ${e}`);
      return;
    }

    case "playwright-reap":
    case "pw-reap": {
      const { flags } = parseFlags(rest, FLAG_SPECS["playwright-reap"]);
      const r = reapStalePlaywrightProcesses({
        dryRun: !!flags.dry,
        maxAgeMs: (flags.minutes || 60) * 60_000,
      });
      console.log(formatPlaywrightReapResult(r));
      for (const p of r.processes.slice(0, 30)) {
        const ageMin = Math.round(p.etimes / 60);
        console.log(`  ${p.pid}\t${p.kind}\t${ageMin}m\t${p.cmd.slice(0, 160)}`);
      }
      if (r.processes.length > 30) console.log(`  ... ${r.processes.length - 30} more`);
      for (const e of r.errors) console.warn(`  ! ${e}`);
      return;
    }

    case "notifyuser":
    case "notify-user":
      return cmdNotifyUser(rest);

    case "todo":
    case "todos":
      return cmdTodo(rest);

    case "morning-digest":
      return cmdMorningDigest(ctx, rest);
    case "todo-remind":
    case "todoremind":
      return cmdTodoRemind(rest);

    case "remind": {
      const { flags, positional } = parseFlags(rest, FLAG_SPECS.remind);
      return cmdRemind(ctx, flags, positional);
    }

    case "tts": {
      return cmdTts(rest[0]);
    }

    case "thinking": {
      return cmdThinking(rest[0]);
    }

    case "reload": {
      return cmdReload();
    }

    case "restart": {
      const { flags } = parseFlags(rest, { all: "boolean" });
      return cmdRestart({ all: !!flags.all });
    }

    case "sync": {
      return cmdSync(rest);
    }

    case "hints-sync": {
      if (rest.length) throw new Error("amux hints-sync accepts no arguments");
      return cmdHintsSync(ctx);
    }

    case "say": {
      return cmdSay(rest, ctx);
    }

    case "image": {
      return cmdImage(rest, ctx);
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

    case "lint": {
      return cmdLint(rest, ctx);
    }
    case "churn": return (await import("../core/churn.mjs")).runChurnCommand(rest);
    case "worktree-deps": {
      return cmdWorktreeDeps(rest);
    }

    case "gate": return cmdScopedGate(rest);
    case "proof": return (await import("../core/measurement-proof.mjs")).runMeasurementProofCommand(rest);

    case "select": {
      if (rest.length < 2) { console.error("Usage: agent select <name|:nr> [-p N] <N>"); process.exit(1); }
      const name = resolveAgent(rest[0], ctx.configPath);
      const { flags, positional } = parseFlags(rest.slice(1), FLAG_SPECS.select);
      if (!positional[0]) { console.error("Usage: agent select <name|:nr> [-p N] <N>"); process.exit(1); }
      return cmdSelect(name, positional[0], flags, ctx);
    }

    case "keys": {
      if (!rest[0]) { console.error("Usage: amux keys <name|:nr> [-p N] <key...>"); process.exit(1); }
      const name = resolveAgent(rest[0], ctx.configPath);
      const { flags, positional } = parseFlags(rest.slice(1), FLAG_SPECS.keys);
      if (!positional.length) { console.error("Usage: amux keys <name|:nr> [-p N] <key...>"); process.exit(1); }
      return cmdKeys(name, positional, flags, ctx);
    }

    case "enter": {
      if (!rest[0]) { console.error("Usage: amux enter <name|:nr> [-p N]"); process.exit(1); }
      const name = resolveAgent(rest[0], ctx.configPath);
      const { flags, positional } = parseFlags(rest.slice(1), FLAG_SPECS.enter);
      if (positional.length) throw new Error("amux enter accepts no key arguments");
      return cmdEnter(name, flags, ctx);
    }

    case "clearline": {
      if (!rest[0]) { console.error("Usage: amux clearline <name|:nr> [-p N]"); process.exit(1); }
      const name = resolveAgent(rest[0], ctx.configPath);
      const { flags, positional } = parseFlags(rest.slice(1), FLAG_SPECS.clearline);
      if (positional.length) throw new Error("amux clearline accepts no key arguments");
      return cmdClearline(name, flags, ctx);
    }

    case "topic": {
      if (rest.length < 2) {
        console.error(`Usage: amux topic <agent|:nr> [-p N] "text"`);
        process.exit(1);
      }
      const name = resolveAgent(rest[0], ctx.configPath);
      const { flags, positional } = parseFlags(rest.slice(1), FLAG_SPECS.topic);
      const text = positional.join(" ").trim();
      if (!text) {
        console.error(`Usage: amux topic <agent|:nr> [-p N] "text"`);
        process.exit(1);
      }
      return cmdTopic(ctx, name, flags.p ?? 0, text);
    }

    case "esc": {
      if (!rest[0]) { console.error("Usage: agent esc <name|:nr>"); process.exit(1); }
      const name = resolveAgent(rest[0], ctx.configPath);
      const { flags, positional } = parseFlags(rest.slice(1), FLAG_SPECS.esc);
      if (positional.length) throw new Error("amux esc accepts no key arguments");
      return cmdEsc(name, flags, ctx);
    }

    case "run": {
      if (rest[0] === "log") {
        const { flags } = parseFlags(rest.slice(1), { n: "number", f: "boolean" });
        return showRunLog(flags.n || 50, flags.f || false);
      }
      if (rest.length < 2) { console.error("Usage: agent run <dir> \"prompt\" [-n channel] [-m session] [-t timeout]"); process.exit(1); }
      const { flags } = parseFlags(rest.slice(2), { n: "string", m: "string", t: "number", fg: "boolean", model: "string", "notify-user": "boolean", "notify-me": "boolean" });
      return runOneshot({ dir: rest[0], prompt: rest[1], timeout: flags.t || 600, notifyChannel: flags.n, msgSession: flags.m, notifyUser: !!(flags["notify-user"] || flags["notify-me"]), model: flags.model, fg: flags.fg ?? false });
    }

    case "plan": {
      if (rest[0] === "log") return showPlanLog();
      if (rest[0] === "status") { console.log("TODO: plan status"); return; }
      if (rest.length < 2 && !rest[0]?.startsWith("-")) { console.error("Usage: agent plan <dir> \"goal\" [-n channel]"); process.exit(1); }
      const dir = rest[0];
      const { flags, positional } = parseFlags(rest.slice(1), { n: "string", m: "string", t: "number", p: "boolean", d: "boolean", fg: "boolean", model: "string", "notify-user": "boolean", "notify-me": "boolean" });
      const goal = positional[0] || "";
      if (!goal && !flags.d) { console.error("Usage: agent plan <dir> \"goal\" [-n channel]"); process.exit(1); }
      return executePlan({ dir, goal, timeout: flags.t || 600, notifyChannel: flags.n, msgSession: flags.m, notifyUser: !!(flags["notify-user"] || flags["notify-me"]), model: flags.model, planOnly: flags.p, dispatchOnly: flags.d, fg: flags.fg ?? false });
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
    default:
      return dispatchAgentTarget(cmd, rest, ctx);
  }
}
