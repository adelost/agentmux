import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { listAgents } from "./config.mjs";
import { compactCodexBeforeSwitch } from "./codex-account-compact.mjs";
import { accountEngineForCommand } from "../core/runtime-account-profiles.mjs";
import { codexProfileCatalog, selectedCodexProfile, setCodexProfile, prepareCodexProfile,
  isCodexProfileAuthenticated } from "../core/codex-profiles.mjs";
import { readLivePaneHomes } from "../core/quota-in-use.mjs";
import { readCodexAccountQuota } from "../core/codex-account-quota.mjs";
import { latestCodexSessionIdentity } from "../core/codex-jsonl-reader.mjs";
import { transferCodexSession } from "../core/codex-session-transfer.mjs";
import { switchCodexAccount } from "../core/codex-account-switch.mjs";
import { prepareCodexAccountHandover } from "../core/codex-account-handover.mjs";
import { driveCodexStatus } from "../core/codex-status.mjs";
import { contextMaintenanceAttempt } from "../core/context-maintenance.mjs";
import { findBlockingPrompt } from "../core/dismiss.mjs";
import { TERMINAL_DELIVERY_STATES } from "../core/delivery-queue-policy.mjs";
import { defaultDeliveryQueueDir } from "../core/delivery-queue.mjs";
import { acquireFileLease } from "../core/file-lease.mjs";

/** WHAT: Defines explicit pane-local account request keys. WHY: Keeps operator intent separate from provider quota evidence and unrelated state writers. */
export const CODEX_ACCOUNT_REQUESTS = "codex_account_requests_v1";
const running = new Set();
const keyOf = (name, pane) => `${name}:${pane}`;
const pendingJobs = (ctx, name, pane) => ctx.deliveryQueue.list(name, pane).some(job => !TERMINAL_DELIVERY_STATES.has(job.status));
const requestOf = (ctx, key) => ctx.state.get(`${CODEX_ACCOUNT_REQUESTS}:${key}`, null);
const save = (ctx, key, value, replace = false) => {
  const field = `${CODEX_ACCOUNT_REQUESTS}:${key}`;
  const change = current => !replace && current && current.id !== value.id ? current : value;
  if (ctx.state.updateKey) return ctx.state.updateKey(field, change);
  const next = change(ctx.state.get(field));
  ctx.state.set(field, next);
  return next;
};
const engine = definition => definition.engine || accountEngineForCommand(definition.cmd);
const defaults = { profiles: codexProfileCatalog, authenticated: isCodexProfileAuthenticated,
  prepare: prepareCodexProfile, live: readLivePaneHomes, quota: readCodexAccountQuota,
  identity: latestCodexSessionIdentity, transfer: transferCodexSession, switchAccount: switchCodexAccount,
  handover: prepareCodexAccountHandover, status: driveCodexStatus, compact: compactCodexBeforeSwitch };

async function observe(ctx, name, pane, deps) {
  const process = await ctx.agent.paneProcessState(name, pane);
  if (process?.running === false || process?.shell || process?.dead) return { dormant: true };
  if (!process?.running) return { blocked: "process-unknown" };
  if (await ctx.agent.isBusy(name, pane)) return { blocked: "working" };
  if (pendingJobs(ctx, name, pane)) return { blocked: "delivery-pending" };
  const screen = await ctx.agent.captureScreen(name, pane);
  if (findBlockingPrompt(screen)) return { blocked: "modal-open" };
  const transport = await ctx.agent.promptTransportState(name, pane, "");
  if (transport.state !== "empty-idle" || transport.busy) return { blocked: "composer-not-empty-idle" };
  const live = (await deps.live())?.find(entry => entry.key === keyOf(name, pane) && entry.engine === "codex");
  const current = live && deps.profiles().find(profile => resolve(profile.home) === resolve(live.home));
  return current ? { dormant: false, current } : { blocked: "live-account-unverified" };
}

function finish(ctx, key, request, result) {
  const text = request.deliveryText ?? [result.text, request.continuation].filter(Boolean).join("\n\n");
  const saved = save(ctx, key, { ...request, phase: "switched", result, deliveryText: text });
  if (saved.id !== request.id) return { key, status: "pending", reason: "request-superseded" };
  const job = text ? ctx.deliveryQueue.enqueue({ agentName: request.name, pane: request.pane, text,
    source: "codex-account-switch", idempotencyKey: `account-switch:${request.id}` }) : null;
  save(ctx, key, { ...request, phase: "complete", result, deliveryText: text, ...(job ? { jobId: job.id } : {}) });
  return { key, ...result, native: result.status, status: result.dormant ? "selected-for-next-start" : result.kind };
}

/** WHAT: Reads one explicit pending selection. WHY: Keeps ordinary watcher ticks free of account work unless the operator requested it. */
export const codexAccountRequest = (state, name, pane) => state.get(`${CODEX_ACCOUNT_REQUESTS}:${keyOf(name, pane)}`, null);

/** WHAT: Reads and dispatches an explicit Codex account request at a verified safe boundary. WHY: Keeps busy turns, drafts, session history and selected models outside account-rotation side effects. */
export async function runRequestedCodexSwitch(ctx, name, pane, options = {}) {
  const key = keyOf(name, pane);
  let request = requestOf(ctx, key);
  if (!request || !["pending", "switched"].includes(request.phase) || running.has(key)) return null;
  const deps = { ...defaults, ...options }, cfg = (options.agents || listAgents(ctx.configPath)).find(entry => entry.name === name);
  // This operation lease spans compact and restart; the compact still owns its separate session lease.
  const operation = acquireFileLease(join(ctx.deliveryQueue.rootDir || defaultDeliveryQueueDir(),
    `.codex-account-${encodeURIComponent(key)}.lock`));
  if (!operation) return { key, status: "pending", reason: "account-switch-in-flight" };
  running.add(key);
  let lease = null;
  try {
    request = requestOf(ctx, key);
    if (!request || !["pending", "switched"].includes(request.phase)) return null;
    if (!cfg || engine(cfg.panes?.[pane] || {}) !== "codex" || cfg.backend === "native" || cfg.dir !== request.dir) {
      throw new Error("configured-target-changed-or-unsupported");
    }
    const profiles = deps.profiles(), target = profiles.find(profile => profile.id === request.target);
    if (!target || !deps.authenticated(target)) throw new Error("target account needs login");
    let observed = await observe(ctx, name, pane, deps);
    if (observed.blocked) return { key, status: "pending", reason: observed.blocked };
    if (request.phase === "switched") {
      if (observed.dormant || observed.current.id !== target.id) throw new Error("account changed before continuation recovery");
      return finish(ctx, key, request, request.result);
    }
    const current = observed.current || selectedCodexProfile(ctx.state, name, pane, profiles);
    const dir = join(cfg.dir, ".agents", String(pane));
    if (!observed.dormant && current.id === target.id) {
      setCodexProfile(ctx.state, name, pane, target.id);
      return finish(ctx, key, request, { kind: "same" });
    }
    deps.prepare(target, profiles[0]);
    const quota = await deps.quota(target);
    const windows = quota.limits?.find(limit => limit.limitId === "codex")?.windows || [];
    if (!quota.ok || !windows.some(window => window.windowMinutes === 10080)
        || windows.some(window => window.usedPercent >= 100)) throw new Error("target has no verified quota room");
    if (observed.dormant) {
      lease = ctx.deliveryQueue.acquireSessionLease(name, pane);
      if (!lease || pendingJobs(ctx, name, pane)) return { key, status: "pending", reason: "delivery-lease-busy" };
      const fresh = await observe(ctx, name, pane, deps);
      if (!fresh.dormant) return { key, status: "pending", reason: "pane-started" };
      const identity = deps.identity(dir, { sessionDirs: [join(current.home, "sessions")] });
      if (identity && current.id !== target.id) {
        const proof = deps.transfer(dir, current, target);
        if (!proof.ok) throw new Error(`dormant history preserved: ${proof.reason}`);
      }
      if (!(await observe(ctx, name, pane, deps)).dormant) return { key, status: "pending", reason: "pane-started-during-transfer" };
      setCodexProfile(ctx.state, name, pane, target.id);
      return finish(ctx, key, request, { kind: "selected", dormant: true, sessionId: identity?.sessionId || null });
    }
    const before = deps.identity(dir, { sessionDirs: [join(current.home, "sessions")] });
    if (!before) throw new Error("source session identity unavailable");
    const prior = contextMaintenanceAttempt(ctx.state, name, pane, before);
    if (prior?.status === "ATTEMPTING") return { key, status: "pending", reason: "compact-already-in-flight" };
    const targetPane = { agent: cfg, pane: { index: pane }, engine: "codex", paneDir: dir, sourceHome: current.home };
    const compact = prior?.status === "VERIFIED" ? { ok: true } : await deps.compact(ctx, targetPane, { force: true });
    if (!compact.ok) {
      if (/^(?:compact-skipped:(?:not-idle:|delivery-|composer-|recent-activity$|not-running-tmux$|session-or-activity-changed$)|context-cost:(?:not-idle:|delivery-|session-or-activity-changed$|compose:)|delivery-lease-busy$)/u.test(compact.reason || "")) {
        return { key, status: "pending", reason: compact.reason };
      }
      throw new Error(`source compact did not verify: ${compact.reason}`);
    }
    lease = ctx.deliveryQueue.acquireSessionLease(name, pane);
    if (!lease) return { key, status: "pending", reason: "delivery-lease-busy" };
    observed = await observe(ctx, name, pane, deps);
    const after = deps.identity(dir, { sessionDirs: [join(current.home, "sessions")] });
    if (requestOf(ctx, key)?.id !== request.id || observed.blocked || observed.dormant
        || observed.current.id !== current.id || after?.sessionId !== before.sessionId) {
      return { key, status: "pending", reason: observed.blocked || "account-or-session-changed" };
    }
    if (contextMaintenanceAttempt(ctx.state, name, pane, after)?.status !== "VERIFIED") {
      return { key, status: "pending", reason: "new-work-or-compact-unverified" };
    }
    const proof = deps.transfer(dir, current, target);
    const handover = proof.ok ? null : deps.handover({ name, pane, dir, current, target,
      refusal: { id: request.id }, cause: "operator-switch" });
    const result = await deps.switchAccount({ agent: ctx.agent, state: ctx.state, name, pane, current, target,
      statusDriver: deps.status, expectedEmail: quota.account?.email,
      ...(proof.ok ? { continuity: proof } : { freshHandover: handover }) });
    if (result.kind !== "switched" && result.kind !== "same") throw new Error(`${result.error}${result.rollbackError ? `; rollback: ${result.rollbackError}` : ""}`);
    return finish(ctx, key, request, result);
  } catch (error) {
    save(ctx, key, { ...request, phase: "blocked", reason: error.message });
    return { key, status: "blocked", reason: error.message };
  } finally { lease?.release(); operation.release(); running.delete(key); }
}

/** WHAT: Stores pane/project-scoped operator switches and previews without mutation. WHY: Keeps explicit paid-account intent separate from quota-triggered automatic recovery. */
export async function switchCodexAccounts(ctx, args, options = {}) {
  const profileId = /^codex:([12])$/u.exec(args[0] || "")?.[1];
  let name = null, pane = null, all = false, dry = false, continuation = null;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--all") all = true;
    else if (arg === "--dry") dry = true;
    else if (["-p", "--pane"].includes(arg) && /^\d+$/u.test(args[index + 1] || "")) pane = Number(args[++index]);
    else if (arg === "--continue-file" && args[index + 1]) continuation = readFileSync(args[++index], "utf8");
    else if (!arg.startsWith("-") && !name) name = arg;
    else throw new Error(`invalid account switch argument: ${arg}`);
  }
  if (!profileId || all === Boolean(name) || (pane !== null && !name) || (continuation && pane === null)) {
    throw new Error("Usage: amux accounts switch codex:1|2 PROJECT [-p N] [--dry] [--continue-file PATH], or --all");
  }
  const deps = { ...defaults, ...options }, agents = options.agents || listAgents(ctx.configPath);
  if (name && !agents.some(agent => agent.name === name)) throw new Error(`unknown project: ${name}`);
  const entries = agents.filter(agent => !name || agent.name === name).flatMap(agent => agent.panes.flatMap((definition, index) =>
    engine(definition) === "codex" && (pane === null || pane === index) ? [{ agent, pane: index }] : []));
  if (!entries.length) throw new Error("no configured Codex panes match that scope");
  const target = deps.profiles().find(profile => profile.id === profileId);
  if (!target || !deps.authenticated(target)) throw new Error("target Codex account needs login");
  const rows = [];
  for (const entry of entries) {
    const key = keyOf(entry.agent.name, entry.pane);
    if (entry.agent.backend === "native") { rows.push({ key, status: "blocked", reason: "native-account-switch-unsupported" }); continue; }
    if (dry) {
      const observed = await observe(ctx, entry.agent.name, entry.pane, deps);
      const selected = observed.current || selectedCodexProfile(ctx.state, entry.agent.name, entry.pane, deps.profiles());
      rows.push({ key, status: observed.blocked ? "would-defer" : selected.id === profileId ? "would-already-selected"
        : observed.dormant ? "would-select-next-start" : "would-compact-then-switch",
        reason: observed.blocked || null });
      continue;
    }
    const existing = requestOf(ctx, key);
    const repeatedComplete = existing?.phase === "complete" && existing.target === profileId
      && selectedCodexProfile(ctx.state, entry.agent.name, entry.pane, deps.profiles()).id === profileId
      && (!continuation || existing.continuation === continuation);
    if (repeatedComplete) save(ctx, key, { ...existing, phase: "pending" });
    else if (!existing || existing.target !== profileId || existing.phase === "blocked" || existing.phase === "complete") {
      save(ctx, key, { id: randomUUID(), name: entry.agent.name, pane: entry.pane, dir: entry.agent.dir,
        target: profileId, phase: "pending", requestedAt: new Date().toISOString(), ...(continuation ? { continuation } : {}) }, true);
    } else if (continuation && existing.continuation !== continuation) {
      save(ctx, key, { ...existing, continuation });
    }
    rows.push(await runRequestedCodexSwitch(ctx, entry.agent.name, entry.pane, { ...options, agents }));
  }
  const output = options.output || console.log;
  for (const row of rows) output(`${row.key} ${row.status}${row.reason ? ` (${row.reason})` : ""}`);
  return { status: dry ? "DRY-RUN" : "REGISTERED", target: profileId, rows };
}
