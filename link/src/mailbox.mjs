// Mailbox state machine for Agentmux Link V1 (docs/link-internet-v1.md).
// Pure decisions here; SQL execution lives in store.mjs so both the worker
// (D1) and the tests (node:sqlite) run the identical statements.

const TERMINAL = new Set(["replied", "failed"]);

/** WHAT: Checks one send and classifies it replay, conflict, or new. WHY: Prevents a duplicate submit from ever double-delivering. */
export function sendDecision({ existing, clientMessageId, target, kind, body, voiceRef = null }) {
  if (existing) {
    const same = existing.target === target &&
      existing.kind === kind &&
      existing.body === body &&
      (existing.voiceRef || null) === voiceRef;
    return same
      ? { action: "replay", status: 200, reason: "idempotent-replay", message: existing }
      : { action: "reject", status: 409, reason: "idempotency-key-reused" };
  }
  return { action: "insert", status: 201, reason: "queued", clientMessageId, target, kind, body };
}

/** WHAT: Returns which leased messages return to the queue. WHY: Keeps a dead connector from holding work hostage past its lease. */
export function reclaimableLeases(nowMs) {
  return { state: "leased", leaseExpiresBefore: nowMs };
}

/** WHAT: Checks one connector claim result. WHY: Keeps exactly-once delivery across connector restarts. */
export function ackDecision({ message, connectorId }) {
  if (!message) return { ok: false, reason: "unknown-message" };
  if (message.state === "delivered" || TERMINAL.has(message.state)) {
    return { ok: true, reason: "already-terminal", idempotent: true };
  }
  if (message.state !== "leased" || message.leaseOwner !== connectorId) {
    return { ok: false, reason: "not-lease-owner" };
  }
  return { ok: true, reason: "deliver" };
}

/** WHAT: Checks how one reply lands. WHY: Keeps the reply bound to its exact originating message. */
export function replyDecision({ message, connectorId }) {
  if (!message) return { ok: false, reason: "unknown-message" };
  if (message.state === "replied") return { ok: true, reason: "already-replied", idempotent: true };
  if (message.state === "failed") return { ok: false, reason: "message-failed" };
  if (message.state !== "delivered" || message.leaseOwner !== connectorId) {
    return { ok: false, reason: "not-delivered-by-connector" };
  }
  return { ok: true, reason: "reply" };
}

/** WHAT: Checks one failure report. WHY: Keeps terminal truth honest instead of a silent retry loop. */
export function failDecision({ message, connectorId }) {
  if (!message) return { ok: false, reason: "unknown-message" };
  if (TERMINAL.has(message.state)) return { ok: true, reason: "already-terminal", idempotent: true };
  if (message.state === "leased" && message.leaseOwner !== connectorId) {
    return { ok: false, reason: "not-lease-owner" };
  }
  return { ok: true, reason: "fail" };
}
