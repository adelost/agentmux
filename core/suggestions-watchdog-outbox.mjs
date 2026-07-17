// Bridge the server outbox to proven agentmux delivery without a third cursor.

import { createHash } from "crypto";
import { lstatSync, readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import yaml from "js-yaml";
import { createDeliveryQueue, waitForDeliveryJob } from "./delivery-queue.mjs";
import { looksDone } from "./orchestrator-checkpoint.mjs";
import { parseSenderHeader } from "./sender-detect.mjs";
import { isSystemNoiseDirective } from "./system-noise.mjs";
import {
  DEFAULT_BROKER_FALLBACK_AFTER_MS,
  prepareWatchdogDelivery,
  reconcileWatchdogFallback,
} from "./suggestions-watchdog-fallback.mjs";

const LIVE_ORIGIN = "https://suggest.v1d.io";
const DEFAULT_DISCOVERY_PROJECT = "source";
const MAX_PROJECTS = 32;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_PROMPT_BYTES = 32 * 1024;
const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
/** WHAT: Defines the sustained-idle assignment threshold. WHY: Keeps short pauses from looking like worker availability. */
export const DEFAULT_ASSIGNMENT_IDLE_MS = 10 * 60_000;
/** WHAT: Defines one safe retry of a prompt proven not sent. WHY: Avoids reviving a deliberate cancellation in the same scheduler tick. */
export const DEFAULT_CANCELLED_REENQUEUE_AFTER_MS = 60_000;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const bytes = (value) => Buffer.byteLength(String(value), "utf8");
const isBearerToken = (value) => typeof value === "string" && value.length >= 32
  && value.length <= 512 && /^[A-Za-z0-9._~+/-]+=*$/u.test(value);

export function watchdogDeliveryKey(projectId, dedupeKey) {
  const digest = createHash("sha256").update(`${projectId}\0${dedupeKey}`).digest("hex");
  return `suggestions-watchdog:${projectId}:${digest}`;
}

/** WHAT: Loads bounded watchdog configuration. WHY: Keeps untrusted origins and paths from reaching delivery. */
export function loadWatchdogOutboxConfig(path, { home = homedir(),
  allowTestOrigin = false } = {}) {
  let raw;
  try { raw = yaml.load(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`config: cannot read ${path}: ${error.message}`); }
  if (!isObject(raw)) throw new Error("config: watchdog outbox config must be an object");
  const baseUrl = String(raw.baseUrl ?? LIVE_ORIGIN);
  let origin;
  try { origin = new URL(baseUrl); } catch { throw new Error("config: baseUrl must be an absolute URL"); }
  if (origin.username || origin.password || origin.search || origin.hash) {
    throw new Error("config: baseUrl must not contain credentials, query, or fragment");
  }
  origin.pathname = origin.pathname.replace(/\/+$/u, "");
  if (!allowTestOrigin && origin.toString().replace(/\/$/u, "") !== LIVE_ORIGIN) {
    throw new Error(`config: baseUrl must use ${LIVE_ORIGIN}`);
  }
  const projects = raw.projects == null || raw.projects === "auto"
    ? null
    : validateProjectIds(raw.projects, "config: projects");
  const discoveryProject = String(raw.discoveryProject ?? DEFAULT_DISCOVERY_PROJECT);
  if (!PROJECT_ID.test(discoveryProject)) {
    throw new Error("config: discoveryProject must be a valid project id");
  }
  const requestTimeoutMs = Number(raw.requestTimeoutMs ?? 15_000);
  const deliveryWaitMs = Number(raw.deliveryWaitMs ?? 12_000);
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 60_000) {
    throw new Error("config: requestTimeoutMs must be 1000-60000");
  }
  if (!Number.isSafeInteger(deliveryWaitMs) || deliveryWaitMs < 0 || deliveryWaitMs > 60_000) {
    throw new Error("config: deliveryWaitMs must be 0-60000");
  }
  return {
    baseUrl: origin.toString().replace(/\/$/u, ""),
    projects,
    discoveryProject,
    requestTimeoutMs,
    deliveryWaitMs,
    readCredentialFile: expandPath(raw.readCredentialFile
      ?? "~/.config/agent/suggestions-read-token", home),
    adminCredentialFile: expandPath(raw.adminCredentialFile
      ?? "~/.config/agent/suggestions-admin-token", home),
  };
}

/** WHAT: Resolves whether one pane can receive a new assignment. WHY: Keeps unfinished work from being interrupted or stacked. */
export function assignmentDeliveryEligibility({ paneStatus, lastAssistantText = null,
  lastAssistantAt = null, lastUserAt = null, now = Date.now(),
  idleMs = DEFAULT_ASSIGNMENT_IDLE_MS }) {
  if (paneStatus !== "idle") {
    return { eligible: false, reason: `pane-${paneStatus || "unknown"}` };
  }
  const assistantAt = Number(lastAssistantAt);
  const userAt = Number(lastUserAt);
  const hasAssistant = Number.isFinite(assistantAt) && assistantAt > 0;
  const hasUser = Number.isFinite(userAt) && userAt > 0;
  if (!hasAssistant && !hasUser) return { eligible: false, reason: "no-turn-data", idleForMs: null };
  const answeredLatest = hasAssistant && (!hasUser || assistantAt >= userAt);
  if (answeredLatest && looksDone(lastAssistantText)) {
    return { eligible: true, reason: "explicit-done", idleForMs: Math.max(0, now - assistantAt) };
  }
  const lastActivityAt = Math.max(hasAssistant ? assistantAt : 0, hasUser ? userAt : 0);
  const idleForMs = lastActivityAt > 0 ? Math.max(0, now - lastActivityAt) : 0;
  if (lastActivityAt > 0 && idleForMs >= idleMs) {
    return { eligible: true, reason: "sustained-idle", idleForMs };
  }
  return { eligible: false, reason: "idle-threshold-not-met", idleForMs };
}

/** WHAT: Builds assignment presence from the real pane timeline. WHY: Keeps broker envelopes from resetting owner activity and makes unreadable histories explicit. */
export function assignmentDeliveryAvailability({ paneStatus, rows = [], agent, pane,
  now = Date.now(), idleMs = DEFAULT_ASSIGNMENT_IDLE_MS }) {
  let lastAssistantText = null, lastAssistantAt = null, lastUserAt = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.agent !== agent || Number(row?.pane) !== Number(pane)
      || (row.type != null && row.type !== "text")) continue;
    const at = Date.parse(String(row.timestamp || ""));
    if (!Number.isFinite(at) || !String(row.content || "").trim()) continue;
    if (row.role === "assistant" && (lastAssistantAt == null || at >= lastAssistantAt)) {
      [lastAssistantAt, lastAssistantText] = [at, String(row.content)];
    }
    if (row.role === "user" && !parseSenderHeader(row.content)
      && !isSystemNoiseDirective(row.content)
      && (lastUserAt == null || at >= lastUserAt)) lastUserAt = at;
  }
  return assignmentDeliveryEligibility({ paneStatus, lastAssistantText, lastAssistantAt,
    lastUserAt, now, idleMs });
}

/** WHAT: Loads one private bearer credential. WHY: Keeps unsafe files and malformed tokens from authorizing delivery. */
export function loadPrivateCredential(path, { uid = process.getuid?.() } = {}) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { throw new Error(`credential: cannot stat ${path}: ${error.code || error.message}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("credential: token must be a regular non-symlink file");
  if (uid != null && stat.uid !== uid) throw new Error("credential: token must be owned by the current uid");
  if ((stat.mode & 0o077) !== 0) throw new Error("credential: token file must be mode 0600");
  const raw = readFileSync(path, "utf8");
  const token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (raw !== token && raw !== `${token}\n`) throw new Error("credential: token must be one line");
  if (!isBearerToken(token)) throw new Error("credential: token must be a bounded bearer token");
  return token;
}

/** WHAT: Dispatches one durable watchdog alert through agentmux. WHY: Keeps cancelled jobs from blocking the outbox forever or fabricating ACKs. */
export function createAmuxOutboxDeliverer({ queue = createDeliveryQueue(),
  waitMs = 12_000, now = () => Date.now(),
  cancelledRetryAfterMs = DEFAULT_CANCELLED_REENQUEUE_AFTER_MS,
  brokerFallbackAfterMs = DEFAULT_BROKER_FALLBACK_AFTER_MS,
  escalate = null } = {}) {
  if (!Number.isSafeInteger(cancelledRetryAfterMs)
    || cancelledRetryAfterMs < 1_000 || cancelledRetryAfterMs > 60 * 60_000) {
    throw new Error("delivery: cancelledRetryAfterMs must be 1000-3600000");
  }
  return async ({ agent, pane, prompt, idempotencyKey, projectId, alert }) => {
    let accepted = queue.enqueue({
      agentName: agent,
      pane,
      text: prompt,
      verifyText: prompt,
      kind: "prompt",
      source: "suggestions-watchdog",
      idempotencyKey,
      metadata: { projectId, outboxId: alert.id, dedupeKey: alert.dedupeKey },
    });
    if (accepted.idempotencyKey !== idempotencyKey || accepted.agentName !== agent
      || Number(accepted.pane) !== pane || accepted.text !== prompt || accepted.verifyText !== prompt
      || accepted.kind !== "prompt" || accepted.source !== "suggestions-watchdog") {
      throw new Error(`delivery: idempotency payload conflict for ${projectId}/${alert.id}`);
    }
    accepted = await prepareWatchdogDelivery({ queue, job: accepted, projectId, alert, now,
      cancelledRetryAfterMs, fallbackAfterMs: brokerFallbackAfterMs, escalate });
    const settled = await waitForDeliveryJob(queue, accepted.id, { timeoutMs: waitMs }) || accepted;
    const fallback = await reconcileWatchdogFallback({ queue, job: settled, projectId, alert,
      now, fallbackAfterMs: brokerFallbackAfterMs, escalate });
    if (settled.status !== "acknowledged" || !Number.isFinite(settled.acknowledgedAt)) {
      if (fallback.state === "blocked") {
        throw new Error(`delivery: agentmux job ${accepted.id} is unacknowledged; fallback opens in ${fallback.remainingMs}ms (ownerAckClockStarted=false)`);
      }
      if (fallback.state === "escalated") {
        throw new Error(`delivery: agentmux job ${accepted.id} is unacknowledged; human escalation persisted (ownerAckClockStarted=false)`);
      }
      throw new Error(`delivery: agentmux job ${accepted.id} is not acknowledged (${settled.status})`);
    }
    return {
      jobId: accepted.id,
      status: "acknowledged",
      acknowledgedAt: Number(settled.acknowledgedAt),
    };
  };
}

/** WHAT: Dispatches eligible watchdog outbox alerts. WHY: Keeps unavailable assignment targets pending without starting their ACK clock. */
export async function pollWatchdogOutboxes({ config, readToken, adminToken,
  fetchImpl = globalThis.fetch, deliver, availability, onAssignmentUnavailable = null,
  now = () => Date.now(), logger = console }) {
  if (!isObject(config) || (config.projects !== null && !Array.isArray(config.projects))
    || typeof deliver !== "function") {
    throw new Error("poller: config and deliver function are required");
  }
  validateToken(readToken, "read");
  validateToken(adminToken, "admin");
  const projects = config.projects === null
    ? await discoverProjects(config, readToken, fetchImpl)
    : validateProjectIds(config.projects, "poller: projects");
  let delivered = 0;
  let pending = 0;
  const errors = [];
  for (const projectId of projects) {
    try {
      const bootstrapUrl = endpoint(config.baseUrl, "/api/config", projectId);
      const bootstrap = await fetchJson(bootstrapUrl, {
        fetchImpl, token: readToken, timeoutMs: config.requestTimeoutMs,
      });
      const broker = brokerTarget(bootstrap, projectId);
      const outboxUrl = endpoint(config.baseUrl, "/api/watchdog/outbox", projectId);
      outboxUrl.searchParams.set("after", "0");
      outboxUrl.searchParams.set("limit", "100");
      const outbox = await fetchJson(outboxUrl, {
        fetchImpl, token: readToken, timeoutMs: config.requestTimeoutMs,
      });
      const alerts = validateAlerts(outbox, projectId);
      for (const alert of alerts) {
        try {
          const target = alertTarget(alert, broker);
          const idempotencyKey = watchdogDeliveryKey(projectId, alert.dedupeKey);
          const prompt = alertPrompt(projectId, alert, bootstrap);
          if (alert.kind === "assignment_offer_delivery") {
            if (typeof availability !== "function") {
              throw new Error("assignment availability reader is required");
            }
            const policy = assignmentDeliveryPolicy(bootstrap);
            const state = await availability({ ...target, projectId, alert,
              idleMs: policy.idleMs });
            if (!isObject(state) || state.eligible !== true) {
              const reason = String(state?.reason || "unknown");
              const observedAt = Number(now());
              const pendingForMs = Number.isSafeInteger(observedAt) ? Math.max(0, observedAt - alert.queuedAt) : 0;
              const shouldAlarm = reason === "no-turn-data" || pendingForMs >= policy.idleMs;
              if (shouldAlarm && typeof onAssignmentUnavailable === "function") {
                const digest = createHash("sha256").update(`${projectId}\0${alert.dedupeKey}\0assignment-availability`).digest("hex");
                const idempotencyKey = `suggestions-watchdog-availability:${digest}`;
                const alarmReason = `assignment-offer-never-attempted:${reason}`;
                const message = `[SRC-0114] Assignment offer ${projectId}/${alert.id} (${alert.ticketId})`
                  + ` to ${target.agent}:${target.pane} was never attempted.`
                  + ` reason=${reason}; ownerAckClockStarted=false (fick aldrig frågan, not owner ACK timeout).`
                  + ` pendingForMs=${pendingForMs}.`;
                try {
                  await onAssignmentUnavailable({ projectId, alert, target, state,
                    ownerAckClockStarted: false, pendingForMs, alarmReason, idempotencyKey, message });
                } catch (error) {
                  throw new Error(`assignment offer was not attempted (${reason}; ownerAckClockStarted=false); human alarm failed: ${error.message}`);
                }
              }
              throw new Error(`assignment offer was not attempted (${reason}; ownerAckClockStarted=false)`);
            }
          }
          const receipt = validateReceipt(await deliver({
            ...target, prompt, idempotencyKey, projectId, alert,
          }), idempotencyKey);
          const ackUrl = endpoint(config.baseUrl, "/api/watchdog/outbox/ack", projectId);
          const acknowledged = await fetchJson(ackUrl, {
            fetchImpl,
            token: adminToken,
            timeoutMs: config.requestTimeoutMs,
            method: "POST",
            body: { id: alert.id, deliveryReceipt: receipt },
          });
          if (acknowledged.acknowledged !== true || acknowledged.id !== alert.id) {
            throw new Error("acknowledgement: exact outbox id was not confirmed");
          }
          delivered += 1;
          logger.info?.(`DELIVERED ${projectId}/${alert.id} ${alert.kind} -> ${target.agent}:${target.pane}`);
        } catch (error) {
          pending += 1;
          errors.push(new Error(`${projectId}/${alert.id}: ${error.message}`));
          logger.error?.(`PENDING ${projectId}/${alert.id} ${alert.kind}: ${error.message}`);
        }
      }
    } catch (error) {
      pending += 1;
      errors.push(new Error(`${projectId}: ${error.message}`));
      logger.error?.(`PENDING ${projectId}: ${error.message}`);
    }
  }
  if (errors.length) throw new AggregateError(errors, `watchdog outbox: ${pending} pending alert(s)`);
  return { delivered, pending, projects: projects.length };
}

async function discoverProjects(config, readToken, fetchImpl) {
  const discoveryProject = String(config.discoveryProject ?? DEFAULT_DISCOVERY_PROJECT);
  if (!PROJECT_ID.test(discoveryProject)) {
    throw new Error("poller: discoveryProject must be a valid project id");
  }
  const registry = await fetchJson(endpoint(config.baseUrl, "/api/config", discoveryProject), {
    fetchImpl,
    token: readToken,
    timeoutMs: config.requestTimeoutMs,
  });
  if (registry?.project?.id !== discoveryProject || !Array.isArray(registry.projects)) {
    throw new Error("schema: project registry missing");
  }
  const projects = validateProjectIds(registry.projects.map((project) => project?.id),
    "schema: project registry");
  if (!projects.includes(discoveryProject)) {
    throw new Error("schema: project registry omits discovery project");
  }
  return projects;
}

function validateProjectIds(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PROJECTS) {
    throw new Error(`${label} must contain 1-${MAX_PROJECTS} project ids`);
  }
  const projects = value.map((project) => String(project));
  if (projects.some((project) => !PROJECT_ID.test(project))) {
    throw new Error(`${label} contains an invalid project id`);
  }
  if (new Set(projects).size !== projects.length) {
    throw new Error(`${label} contains duplicate project ids`);
  }
  return projects;
}

function expandPath(path, home) {
  if (String(path) === "~") return home;
  if (String(path).startsWith("~/")) return resolve(home, String(path).slice(2));
  return resolve(String(path));
}

function validateToken(token, label) {
  if (!isBearerToken(token)) {
    throw new Error(`poller: bounded ${label} credential is required`);
  }
}

function endpoint(baseUrl, pathname, projectId) {
  if (!PROJECT_ID.test(projectId)) throw new Error(`schema: invalid project '${projectId}'`);
  const url = new URL(pathname, baseUrl);
  url.searchParams.set("project", projectId);
  return url;
}

async function fetchJson(url, { fetchImpl, token, timeoutMs,
  method = "GET", body = null }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body == null ? {} : { "content-type": "application/json" }),
      },
      ...(body == null ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: controller.signal,
    });
    text = await response.text();
  } finally {
    clearTimeout(timer);
  }
  if (bytes(text) > MAX_RESPONSE_BYTES) throw new Error(`HTTP ${response.status}: response too large`);
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`HTTP ${response.status}: invalid JSON`); }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${String(value?.error || "request failed")}`);
  if (!isObject(value)) throw new Error(`HTTP ${response.status}: JSON object required`);
  return value;
}

function brokerTarget(value, projectId) {
  const project = value?.assignmentBootstrap?.project ?? value?.project;
  const routingBroker = value?.project?.routingGuide?.workers
    ?.find?.((worker) => isObject(worker) && worker.role === "broker")?.id;
  const brokerOwner = project?.brokerOwner ?? routingBroker;
  if (!isObject(project) || project.id !== projectId || typeof brokerOwner !== "string") {
    throw new Error("schema: bootstrap project/brokerOwner missing");
  }
  const match = brokerOwner.match(/^([a-z][a-z0-9-]{0,31}):([0-9]{1,3})$/u);
  const pane = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(pane) || pane < 0 || pane > 128) {
    throw new Error("schema: bootstrap brokerOwner is not an agentmux target");
  }
  return { agent: match[1], pane };
}

function alertTarget(alert, broker) {
  if (alert.kind !== "assignment_offer_delivery") return broker;
  const targetAgent = alert.payload.targetAgent;
  const match = typeof targetAgent === "string"
    ? targetAgent.match(/^([a-z][a-z0-9-]{0,31}):([0-9]{1,3})$/u) : null;
  const pane = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(pane) || pane < 0 || pane > 128) {
    throw new Error("schema: assignment offer targetAgent is not an agentmux target");
  }
  return { agent: match[1], pane };
}

function assignmentDeliveryPolicy(value) {
  const policy = value?.assignmentDelivery;
  if (!isObject(policy) || policy.version !== "assignment-delivery.v1"
    || policy.requireExplicitDoneOrSustainedIdle !== true
    || policy.unknownPresence !== "deny"
    || !Number.isSafeInteger(policy.idleMs)
    || policy.idleMs < 60_000 || policy.idleMs > 2 * 60 * 60_000) {
    throw new Error("schema: assignment delivery availability policy missing");
  }
  return policy;
}

function validateAlerts(value, projectId) {
  if (!Array.isArray(value?.alerts)) throw new Error("schema: outbox alerts[] missing");
  return value.alerts.map((row, index) => {
    if (!isObject(row) || !Number.isSafeInteger(row.id) || row.id <= 0
      || typeof row.ticketId !== "string" || !/^[A-Z][A-Z0-9]*-[0-9]{4,}$/u.test(row.ticketId)
      || typeof row.kind !== "string" || !/^[a-z][a-z0-9_]{1,63}$/u.test(row.kind)
      || typeof row.dedupeKey !== "string" || bytes(row.dedupeKey) > 256 || !row.dedupeKey
      || !isObject(row.payload)) throw new Error(`schema: invalid ${projectId} alert ${index}`);
    const queuedAt = row.queuedAt ?? row.createdAt;
    if (!Number.isSafeInteger(queuedAt) || queuedAt < 0 || row.deliveredAt != null) {
      throw new Error(`schema: invalid ${projectId} alert timestamps ${index}`);
    }
    return { ...row, id: Number(row.id), queuedAt, deliveredAt: null };
  });
}

function alertPrompt(projectId, alert, bootstrap) {
  if (alert.kind === "assignment_offer_delivery") {
    if (typeof alert.payload.offerPrompt !== "string" || !alert.payload.offerPrompt.trim()) {
      throw new Error("schema: assignment offerPrompt is missing");
    }
    if (bytes(alert.payload.offerPrompt) > MAX_PROMPT_BYTES) {
      throw new Error("schema: assignment offerPrompt is oversized");
    }
    return alert.payload.offerPrompt;
  }
  if (alert.kind === "broker_check_due") {
    if (typeof alert.payload.resolvedPrompt !== "string"
      || !alert.payload.resolvedPrompt.trim()) {
      const recovered = recoverLegacyBrokerCheckPrompt(alert, bootstrap);
      if (recovered) return recovered;
      throw new Error("schema: broker_check_due resolvedPrompt is missing");
    }
    if (bytes(alert.payload.resolvedPrompt) > MAX_PROMPT_BYTES) {
      throw new Error("schema: broker_check_due resolvedPrompt is oversized");
    }
    return alert.payload.resolvedPrompt;
  }
  const prompt = `WATCHDOG ALERT — ${projectId}/${alert.ticketId} — ${alert.kind}\n${JSON.stringify({
    id: alert.id,
    ticketId: alert.ticketId,
    assignmentId: alert.assignmentId ?? null,
    dedupeKey: alert.dedupeKey,
    payload: alert.payload,
    queuedAt: alert.queuedAt,
  })}`;
  if (bytes(prompt) > MAX_PROMPT_BYTES) throw new Error("schema: watchdog alert prompt is oversized");
  return prompt;
}

function recoverLegacyBrokerCheckPrompt(alert, bootstrap) {
  const policy = bootstrap?.watchdogPolicy;
  const template = policy?.resolvedPromptTemplate;
  const declaredHash = policy?.templateHash;
  const payloadHash = alert.payload.templateHash;
  const policyScope = policy?.overrideScope;
  const payloadScope = alert.payload.overrideScope;
  const policyVersion = policy?.templateVersion;
  const payloadVersion = alert.payload.templateVersion;
  const generation = Number(alert.payload.generation);
  if (!isObject(policy) || typeof template !== "string" || !template.trim()
    || bytes(template) > MAX_PROMPT_BYTES
    || typeof declaredHash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(declaredHash)
    || payloadHash !== declaredHash || payloadScope !== policyScope
    || !Number.isSafeInteger(generation) || generation < 0) return null;
  const computedHash = `sha256:${createHash("sha256").update(template).digest("hex")}`;
  if (computedHash !== declaredHash) return null;
  const compatibleVersion = payloadVersion === policyVersion
    || (payloadVersion === "off-board.v1" && payloadScope === "default"
      && policyScope === "default");
  if (!compatibleVersion) return null;
  const rendered = template
    .replaceAll("{{ticket.id}}", alert.ticketId)
    .replaceAll("{{assignment.generation}}", String(generation));
  if (!rendered.trim() || /\{\{|\}\}/u.test(rendered)
    || bytes(rendered) > MAX_PROMPT_BYTES) return null;
  return rendered;
}

function validateReceipt(value, idempotencyKey) {
  if (!isObject(value) || value.status !== "acknowledged"
    || typeof value.jobId !== "string" || !/^[a-f0-9]{32}$/u.test(value.jobId)
    || !Number.isSafeInteger(value.acknowledgedAt) || value.acknowledgedAt < 0) {
    throw new Error("delivery: exact acknowledged agentmux receipt required");
  }
  return { idempotencyKey, jobId: value.jobId, status: "acknowledged",
    acknowledgedAt: Number(value.acknowledgedAt) };
}
