// Shared, restart-safe HTTP boundary for every local Suggestions cron.
// It owns pacing and availability only. Domain validation and delivery
// receipts remain with each caller.

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATE_VERSION = 1;
const LOCK_STALE_MS = 30_000;
const MIN_PROBE_LEASE_MS = 30_000;
const RECOVERY_SPREAD_MS = 20_000;
const RETRYABLE_BASE_MS = 60_000;
const RETRYABLE_CAP_MS = 15 * 60_000;
const NON_RETRYABLE_BASE_MS = 15 * 60_000;
const NON_RETRYABLE_CAP_MS = 2 * 60 * 60_000;

const emptyState = () => ({
  schemaVersion: STATE_VERSION,
  consecutiveFailures: 0,
  blockedUntil: 0,
  recoveryUntil: 0,
  recoveryOwner: null,
  probe: null,
  lastFailure: null,
  lastSuccessAt: null,
});

const finiteTimestamp = (value) => Number.isFinite(value) && value >= 0;
const validState = (value) => Boolean(value) && typeof value === "object"
  && value.schemaVersion === STATE_VERSION
  && Number.isSafeInteger(value.consecutiveFailures) && value.consecutiveFailures >= 0
  && finiteTimestamp(value.blockedUntil)
  && finiteTimestamp(value.recoveryUntil)
  && (value.recoveryOwner == null || (typeof value.recoveryOwner.token === "string"
    && finiteTimestamp(value.recoveryOwner.expiresAt)))
  && (value.lastSuccessAt == null || finiteTimestamp(value.lastSuccessAt))
  && (value.probe == null || (typeof value.probe.token === "string"
    && finiteTimestamp(value.probe.expiresAt)))
  && (value.lastFailure == null || (finiteTimestamp(value.lastFailure.at)
    && (value.lastFailure.status == null || Number.isSafeInteger(value.lastFailure.status))
    && typeof value.lastFailure.retryable === "boolean"
    && typeof value.lastFailure.reason === "string"));

const privateDirectory = (path) => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
};

const atomicStateWrite = (path, state) => {
  privateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
};

export function readSuggestionsCircuitState(path) {
  if (!existsSync(path)) return emptyState();
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("circuit-state-invalid"); }
  if (!validState(value)) throw new Error("circuit-state-invalid");
  return value;
}

const processAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
};

const staleLock = (path, nowMs) => {
  try {
    const owner = JSON.parse(readFileSync(path, "utf8"));
    return !processAlive(Number(owner.pid)) || nowMs - Number(owner.acquiredAt) > LOCK_STALE_MS;
  } catch {
    return true;
  }
};

const acquireStateLock = (path, nowMs) => {
  privateDirectory(dirname(path));
  const lockPath = `${path}.lock`;
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, acquiredAt: nowMs })}\n`);
      closeSync(fd);
      return () => {
        try {
          if (JSON.parse(readFileSync(lockPath, "utf8")).token === token) unlinkSync(lockPath);
        } catch {}
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (attempt === 0 && staleLock(lockPath, nowMs)) {
        try { unlinkSync(lockPath); } catch {}
        continue;
      }
      throw new SuggestionsCircuitOpenError("circuit-state-busy", nowMs + 1_000);
    }
  }
  throw new SuggestionsCircuitOpenError("circuit-state-busy", nowMs + 1_000);
};

const fileStore = (path) => ({
  transact(nowMs, change) {
    const release = acquireStateLock(path, nowMs);
    try {
      let current;
      try { current = readSuggestionsCircuitState(path); }
      catch { throw new SuggestionsCircuitOpenError("circuit-state-invalid", null); }
      const { state, result } = change(current);
      atomicStateWrite(path, state);
      return result;
    } finally {
      release();
    }
  },
});

const memoryStore = () => {
  let current = emptyState();
  return {
    transact(_nowMs, change) {
      const { state, result } = change(structuredClone(current));
      current = state;
      return result;
    },
  };
};

const utcDate = (nowMs) => new Date(nowMs).toISOString().slice(0, 10);

export function cronStartJitterMs(source, nowMs, maxMs = 20_000) {
  if (!Number.isSafeInteger(maxMs) || maxMs <= 0) return 0;
  const minimum = Math.min(1_000, maxMs);
  const slots = maxMs - minimum + 1;
  const digest = createHash("sha256").update(`${utcDate(nowMs)}\0${source}`).digest();
  return minimum + (digest.readUInt32BE(0) % slots);
}

const retryAfterMs = (response, nowMs) => {
  const value = response.headers.get("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : 0;
};

const circuitDelayMs = ({ retryable, consecutiveFailures, retryAfter = 0, jitterUnit }) => {
  const base = retryable ? RETRYABLE_BASE_MS : NON_RETRYABLE_BASE_MS;
  const cap = retryable ? RETRYABLE_CAP_MS : NON_RETRYABLE_CAP_MS;
  const exponent = Math.min(20, Math.max(0, consecutiveFailures - 1));
  const bounded = Math.min(cap, base * (2 ** exponent));
  const unit = Math.max(0, Math.min(1, Number(jitterUnit()) || 0));
  return Math.max(retryAfter, bounded + Math.floor(bounded * 0.2 * unit));
};

const boundedReason = (value) => String(value ?? "unknown")
  .replace(/[\r\n\t]+/gu, " ").slice(0, 160);

export class SuggestionsCircuitOpenError extends Error {
  constructor(reason, retryAt) {
    super(`suggestions circuit open: ${reason}`);
    this.name = "SuggestionsCircuitOpenError";
    this.reason = reason;
    this.retryAt = retryAt;
    this.status = null;
    this.retryable = false;
  }
}

export class SuggestionsHttpError extends Error {
  constructor({ method, url, status, retryable, reason, code = null }) {
    super(`http: ${method} ${new URL(url).pathname} ${status == null ? "failed" : `returned ${status}`}`);
    this.name = "SuggestionsHttpError";
    this.method = method;
    this.status = status;
    this.retryable = retryable;
    this.reason = reason;
    this.code = code;
  }
}

const reserveRequest = (store, nowMs, leaseMs, clientId) => store.transact(nowMs, (state) => {
  if (state.recoveryUntil > nowMs && state.recoveryOwner?.token !== clientId) {
    throw new SuggestionsCircuitOpenError("circuit-recovering", state.recoveryUntil);
  }
  if (state.recoveryUntil <= nowMs) state.recoveryOwner = null;
  if (state.blockedUntil > nowMs) {
    throw new SuggestionsCircuitOpenError("circuit-backoff", state.blockedUntil);
  }
  if (state.probe && state.probe.expiresAt > nowMs) {
    throw new SuggestionsCircuitOpenError("circuit-probe-active", state.probe.expiresAt);
  }
  if (state.probe && state.probe.expiresAt <= nowMs) state.probe = null;
  if (state.consecutiveFailures === 0) return { state, result: null };
  const token = randomUUID();
  state.probe = { token, expiresAt: nowMs + Math.max(MIN_PROBE_LEASE_MS, leaseMs) };
  return { state, result: token };
});

const recordFailure = (store, { nowMs, token, status, retryable, reason, retryAfter,
  jitterUnit }) => store.transact(nowMs, (state) => {
    if (token && state.probe?.token === token) state.probe = null;
    state.consecutiveFailures += 1;
    const delay = circuitDelayMs({ retryable, consecutiveFailures: state.consecutiveFailures,
      retryAfter, jitterUnit });
    state.blockedUntil = Math.max(state.blockedUntil, nowMs + delay);
    state.recoveryUntil = 0;
    state.recoveryOwner = null;
    state.lastFailure = { at: nowMs, status, retryable, reason: boundedReason(reason) };
    return { state, result: state.blockedUntil };
  });

const recordNeutral = (store, { nowMs, token }) => store.transact(nowMs, (state) => {
  if (token && state.probe?.token === token) {
    state.probe = null;
    state.blockedUntil = Math.max(state.blockedUntil, nowMs + RETRYABLE_BASE_MS);
  }
  return { state, result: null };
});

const recordSuccess = (store, { nowMs, token, source, startJitterMaxMs, clientId }) =>
  store.transact(nowMs, (state) => {
    const recovered = state.consecutiveFailures > 0;
    if (token && state.probe?.token === token) state.probe = null;
    state.consecutiveFailures = 0;
    state.blockedUntil = 0;
    if (recovered) {
      state.recoveryUntil = nowMs + cronStartJitterMs(`recovery:${source}`, nowMs,
        Math.min(RECOVERY_SPREAD_MS, startJitterMaxMs || RECOVERY_SPREAD_MS));
      state.recoveryOwner = { token: clientId, expiresAt: state.recoveryUntil };
    } else if (state.recoveryUntil <= nowMs) {
      state.recoveryUntil = 0;
      state.recoveryOwner = null;
    }
    state.lastSuccessAt = nowMs;
    return { state, result: null };
  });

const readBounded = async (response, maxBytes) => {
  if (!response.body) return "";
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`response exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
};

const parseJson = (text) => {
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { throw new Error("response is not valid JSON"); }
};

export const suggestionsCircuitPath = () => process.env.AMUX_SUGGESTIONS_CIRCUIT_STATE
  || join(homedir(), ".agentmux", "suggestions-http-circuit.json");

export function createSuggestionsHttpClient({
  source,
  statePath = suggestionsCircuitPath(),
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  startJitterMaxMs = 20_000,
  jitterUnit = Math.random,
} = {}) {
  if (!source || typeof fetchImpl !== "function") {
    throw new Error("suggestions HTTP client requires source and fetch");
  }
  const store = statePath ? fileStore(statePath) : memoryStore();
  const clientId = randomUUID();
  let startDelay = null;
  const waitForStart = () => {
    startDelay ??= Promise.resolve(sleep(cronStartJitterMs(source, now(), startJitterMaxMs)));
    return startDelay;
  };

  return Object.freeze({
    async requestJson(url, {
      token,
      timeoutMs = 15_000,
      maxBytes = 512 * 1024,
      method = "GET",
      body = null,
      headers = {},
      expectedStatus = null,
    } = {}) {
      const requestMethod = String(method).toUpperCase();
      const reservedAt = now();
      const probeToken = reserveRequest(store, reservedAt,
        timeoutMs + startJitterMaxMs + 5_000, clientId);
      await waitForStart();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      let response;
      try {
        response = await fetchImpl(url, {
          method: requestMethod,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            ...(body == null ? {} : { "content-type": "application/json" }),
            ...headers,
          },
          ...(body == null ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
          redirect: "error",
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        const reason = error?.name === "AbortError" ? "timeout"
          : String(error?.code || error?.name || "network-error");
        recordFailure(store, { nowMs: now(), token: probeToken, status: null,
          retryable: true, reason, retryAfter: 0, jitterUnit });
        throw new SuggestionsHttpError({ method: requestMethod, url, status: null,
          retryable: true, reason });
      }

      let text;
      try { text = await readBounded(response, maxBytes); }
      catch (error) {
        clearTimeout(timer);
        recordFailure(store, { nowMs: now(), token: probeToken, status: response.status,
          retryable: response.status >= 500, reason: "response-invalid",
          retryAfter: retryAfterMs(response, now()), jitterUnit });
        throw new SuggestionsHttpError({ method: requestMethod, url, status: response.status,
          retryable: response.status >= 500, reason: error.message });
      }
      clearTimeout(timer);
      let value = null;
      try { value = parseJson(text); }
      catch (error) {
        if (response.status >= 500) {
          recordFailure(store, { nowMs: now(), token: probeToken, status: response.status,
            retryable: true, reason: "response-invalid",
            retryAfter: retryAfterMs(response, now()), jitterUnit });
        } else {
          recordNeutral(store, { nowMs: now(), token: probeToken });
        }
        throw new SuggestionsHttpError({ method: requestMethod, url, status: response.status,
          retryable: response.status >= 500, reason: error.message });
      }

      if (!response.ok) {
        const retryable = response.status >= 500
          ? value?.retryable !== false
          : response.status === 429;
        const reason = typeof value?.reason === "string" ? value.reason
          : typeof value?.error === "string" ? value.error : "request-failed";
        if (response.status >= 500 || response.status === 429) {
          recordFailure(store, { nowMs: now(), token: probeToken, status: response.status,
            retryable, reason, retryAfter: retryAfterMs(response, now()), jitterUnit });
        } else {
          recordNeutral(store, { nowMs: now(), token: probeToken });
        }
        throw new SuggestionsHttpError({ method: requestMethod, url, status: response.status,
          retryable, reason, code: typeof value?.error === "string" ? value.error : null });
      }

      recordSuccess(store, { nowMs: now(), token: probeToken, source, startJitterMaxMs,
        clientId });
      if (expectedStatus != null && response.status !== expectedStatus) {
        throw new SuggestionsHttpError({ method: requestMethod, url, status: response.status,
          retryable: false, reason: `expected-status-${expectedStatus}` });
      }
      return value;
    },
  });
}
