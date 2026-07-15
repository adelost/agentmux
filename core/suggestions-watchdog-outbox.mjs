// Drain Suggestions watchdog outboxes only after agentmux proves pane delivery.
// The server outbox and agentmux queue are the two durable halves; this bridge
// deliberately keeps no third cursor that could skip a pending alert.

import { createHash } from "crypto";
import { lstatSync, readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import yaml from "js-yaml";
import { createDeliveryQueue, waitForDeliveryJob } from "./delivery-queue.mjs";

const LIVE_ORIGIN = "https://suggest.v1d.io";
const REQUIRED_PROJECTS = Object.freeze(["source", "skydive"]);
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_PROMPT_BYTES = 32 * 1024;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const bytes = (value) => Buffer.byteLength(String(value), "utf8");
const isBearerToken = (value) => typeof value === "string" && value.length >= 32
  && value.length <= 512 && /^[A-Za-z0-9._~+/-]+=*$/u.test(value);

export function watchdogDeliveryKey(projectId, dedupeKey) {
  const digest = createHash("sha256").update(`${projectId}\0${dedupeKey}`).digest("hex");
  return `suggestions-watchdog:${projectId}:${digest}`;
}

export function loadWatchdogOutboxConfig(path, {
  home = homedir(),
  allowTestOrigin = false,
} = {}) {
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
  const projects = Array.isArray(raw.projects) ? raw.projects.map(String) : REQUIRED_PROJECTS;
  if (projects.length !== REQUIRED_PROJECTS.length
    || REQUIRED_PROJECTS.some((project) => !projects.includes(project))
    || new Set(projects).size !== projects.length) {
    throw new Error("config: projects must contain source and skydive exactly once");
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
    requestTimeoutMs,
    deliveryWaitMs,
    readCredentialFile: expandPath(raw.readCredentialFile
      ?? "~/.config/agent/suggestions-read-token", home),
    adminCredentialFile: expandPath(raw.adminCredentialFile
      ?? "~/.config/agent/suggestions-admin-token", home),
  };
}

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

export function createAmuxOutboxDeliverer({
  queue = createDeliveryQueue(),
  waitMs = 12_000,
} = {}) {
  return async ({ agent, pane, prompt, idempotencyKey, projectId, alert }) => {
    const accepted = queue.enqueue({
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
    const settled = await waitForDeliveryJob(queue, accepted.id, { timeoutMs: waitMs }) || accepted;
    if (settled.status !== "acknowledged" || !Number.isFinite(settled.acknowledgedAt)) {
      throw new Error(`delivery: agentmux job ${accepted.id} is not acknowledged (${settled.status})`);
    }
    return {
      jobId: accepted.id,
      status: "acknowledged",
      acknowledgedAt: Number(settled.acknowledgedAt),
    };
  };
}

export async function pollWatchdogOutboxes({
  config,
  readToken,
  adminToken,
  fetchImpl = globalThis.fetch,
  deliver,
  logger = console,
}) {
  if (!isObject(config) || !Array.isArray(config.projects) || typeof deliver !== "function") {
    throw new Error("poller: config projects and deliver function are required");
  }
  validateToken(readToken, "read");
  validateToken(adminToken, "admin");
  let delivered = 0;
  let pending = 0;
  const errors = [];
  for (const projectId of config.projects) {
    try {
      const bootstrapUrl = endpoint(config.baseUrl, "/api/config/agentdocs", projectId);
      const bootstrap = await fetchJson(bootstrapUrl, {
        fetchImpl, token: readToken, timeoutMs: config.requestTimeoutMs,
      });
      const target = brokerTarget(bootstrap, projectId);
      const outboxUrl = endpoint(config.baseUrl, "/api/watchdog/outbox", projectId);
      outboxUrl.searchParams.set("after", "0");
      outboxUrl.searchParams.set("limit", "100");
      const outbox = await fetchJson(outboxUrl, {
        fetchImpl, token: readToken, timeoutMs: config.requestTimeoutMs,
      });
      const alerts = validateAlerts(outbox, projectId);
      for (const alert of alerts) {
        const idempotencyKey = watchdogDeliveryKey(projectId, alert.dedupeKey);
        const prompt = alertPrompt(projectId, alert);
        try {
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
  return { delivered, pending, projects: config.projects.length };
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
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(projectId)) throw new Error(`schema: invalid project '${projectId}'`);
  const url = new URL(pathname, baseUrl);
  url.searchParams.set("project", projectId);
  return url;
}

async function fetchJson(url, {
  fetchImpl,
  token,
  timeoutMs,
  method = "GET",
  body = null,
}) {
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
  const routingBroker = value?.project?.routingGuide?.workers?.find?.(
    (worker) => isObject(worker) && worker.role === "broker",
  )?.id;
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

function alertPrompt(projectId, alert) {
  if (alert.kind === "broker_check_due") {
    if (typeof alert.payload.resolvedPrompt !== "string" || !alert.payload.resolvedPrompt.trim()
      || bytes(alert.payload.resolvedPrompt) > MAX_PROMPT_BYTES) {
      throw new Error("schema: broker_check_due resolvedPrompt is missing or oversized");
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

function validateReceipt(value, idempotencyKey) {
  if (!isObject(value) || value.status !== "acknowledged"
    || typeof value.jobId !== "string" || !/^[a-f0-9]{32}$/u.test(value.jobId)
    || !Number.isSafeInteger(value.acknowledgedAt) || value.acknowledgedAt < 0) {
    throw new Error("delivery: exact acknowledged agentmux receipt required");
  }
  return {
    idempotencyKey,
    jobId: value.jobId,
    status: "acknowledged",
    acknowledgedAt: Number(value.acknowledgedAt),
  };
}
