import { createHash } from "node:crypto";

/** WHAT: Names the restart-ready receipt schema. WHY: Keeps Windows and WSL on one persisted contract. */
export const RESTART_READY_SCHEMA_VERSION = 1;
/** WHAT: Defines the maximum receipt lifetime. WHY: Prevents old fleet observations from authorizing a later shutdown. */
export const RESTART_READY_TTL_MS = 10 * 60_000;

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** WHAT: Calculates one boot-bound fleet generation. WHY: Prevents a receipt from authorizing a different configured or running fleet. */
export function calculateFleetGeneration({
  bootId,
  sourceSha,
  configSha,
  sessions = [],
} = {}) {
  return hash({
    bootId: bootId || null,
    sourceSha: sourceSha || null,
    configSha: configSha || null,
    sessions: [...sessions].map(String).sort(),
  });
}

/** WHAT: Builds either exact restart blockers or one bounded receipt. WHY: Prevents checkpoint prose from masquerading as restart readiness. */
export function buildRestartReadiness({
  bootId,
  sourceSha,
  configSha,
  sessions = [],
  panels = [],
  deliveries = [],
  worktrees = [],
  auth = {},
  identityOk = false,
  identityReason = "unverified",
  nowMs = Date.now(),
  ttlMs = RESTART_READY_TTL_MS,
} = {}) {
  const blockers = [];
  for (const panel of panels) {
    if (panel.state !== "idle") blockers.push({
      kind: "panel",
      id: `${panel.agent}:${panel.pane}`,
      reason: panel.reason || panel.state,
    });
  }
  for (const delivery of deliveries) blockers.push({
    kind: "delivery",
    id: String(delivery.id),
    reason: delivery.status || "unfinished",
  });
  for (const worktree of worktrees) {
    if (worktree.dirty) blockers.push({ kind: "worktree", id: worktree.path, reason: "dirty" });
    if (worktree.operation) blockers.push({
      kind: "worktree",
      id: worktree.path,
      reason: worktree.operation,
    });
  }
  if (!identityOk) blockers.push({ kind: "release", id: sourceSha || "unknown", reason: identityReason });
  if (!bootId) blockers.push({ kind: "boot", id: "unknown", reason: "boot-id-missing" });
  if (!sourceSha) blockers.push({ kind: "release", id: "unknown", reason: "source-sha-missing" });

  const fleetGeneration = calculateFleetGeneration({ bootId, sourceSha, configSha, sessions });
  const inventory = {
    panels: panels.map((panel) => ({
      agent: panel.agent,
      pane: panel.pane,
      engine: panel.engine,
      state: panel.state,
      reason: panel.reason || null,
    })),
    deliveries: deliveries.map((job) => ({
      id: String(job.id),
      target: `${job.agentName}:${job.pane}`,
      status: job.status,
    })),
    worktrees,
    auth,
  };
  if (blockers.length) {
    return { ready: false, blockers, fleetGeneration, inventory };
  }
  const receiptSeed = {
    schemaVersion: RESTART_READY_SCHEMA_VERSION,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    bootId,
    fleetGeneration,
    sourceSha,
  };
  const receiptId = hash(receiptSeed).slice(0, 32);
  return {
    ready: true,
    blockers: [],
    receipt: {
      ...receiptSeed,
      receiptId,
      ready: true,
      inventory,
    },
  };
}

/** WHAT: Checks one receipt against current boot and fleet truth. WHY: Prevents stale, copied, or amended receipts from authorizing shutdown. */
export function verifyRestartReadyReceipt(receipt, {
  receiptId,
  bootId,
  fleetGeneration,
  sourceSha,
  nowMs = Date.now(),
} = {}) {
  if (!receipt || receipt.schemaVersion !== RESTART_READY_SCHEMA_VERSION || receipt.ready !== true) {
    return { allow: false, reason: "restart-ready-receipt-shape" };
  }
  if (receiptId && receipt.receiptId !== receiptId) {
    return { allow: false, reason: "restart-ready-receipt-id" };
  }
  if (!Number.isFinite(receipt.createdAtMs) || !Number.isFinite(receipt.expiresAtMs)
    || receipt.createdAtMs > nowMs || receipt.expiresAtMs < nowMs) {
    return { allow: false, reason: "restart-ready-receipt-stale" };
  }
  if (bootId && receipt.bootId !== bootId) {
    return { allow: false, reason: "restart-ready-receipt-boot" };
  }
  if (fleetGeneration && receipt.fleetGeneration !== fleetGeneration) {
    return { allow: false, reason: "restart-ready-receipt-generation" };
  }
  if (sourceSha && receipt.sourceSha !== sourceSha) {
    return { allow: false, reason: "restart-ready-receipt-source" };
  }
  return { allow: true, reason: "ok" };
}
