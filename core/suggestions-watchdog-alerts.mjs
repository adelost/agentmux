import { createHash } from "node:crypto";

const MAX_PROMPT_BYTES = 32 * 1024;
const bytes = (value) => Buffer.byteLength(String(value), "utf8");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** WHAT: Defines human-only watchdog alerts. WHY: Prevents owner gates from falling back to an agent pane. */
export const HUMAN_DIRECTED_ALERT_KINDS = Object.freeze(new Set(["owner_gate_due"]));

/** WHAT: Resolves one alert target. WHY: Keeps explicit worker routing separate from broker fallback. */
export function alertTarget(alert, broker) {
  if (HUMAN_DIRECTED_ALERT_KINDS.has(alert.kind)) {
    throw new Error(`delivery: ${alert.kind} is owner-directed and has no pane target`);
  }
  const field = alert.kind === "assignment_offer_delivery" ? "targetAgent"
    : alert.kind === "pull_claim_attention_due" ? "targetAgentId" : null;
  if (!field) return broker;
  const targetAgent = alert.payload[field];
  const match = typeof targetAgent === "string"
    ? targetAgent.match(/^([a-z][a-z0-9-]{0,31}):([0-9]{1,3})$/u) : null;
  const pane = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(pane) || pane < 0 || pane > 128) {
    throw new Error(`schema: ${alert.kind} ${field} is not an agentmux target`);
  }
  return { agent: match[1], pane };
}

/** WHAT: Checks assignment delivery policy. WHY: Prevents unknown presence from authorizing delivery. */
export function assignmentDeliveryPolicy(value) {
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

/** WHAT: Checks one project alert page. WHY: Prevents malformed server rows from entering delivery. */
export function validateAlerts(value, projectId) {
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
  if (alert.kind === "pull_claim_attention_due") {
    const question = alert.payload.question;
    if (typeof question !== "string" || !question.trim()) {
      throw new Error("schema: pull_claim_attention_due question is missing");
    }
    const prompt = `[BOARD CHECK · ${alert.ticketId}] ${question.trim()}\n`
      + `Fetch /api/agent/overview?project=${projectId}&recent=5 and submit its exact `
      + "pendingActions response. Chat text alone is not a board acknowledgement.";
    if (bytes(prompt) > MAX_PROMPT_BYTES) {
      throw new Error("schema: pull_claim_attention_due question is oversized");
    }
    return prompt;
  }
  const prompt = `WATCHDOG ALERT: ${projectId}/${alert.ticketId}: ${alert.kind}\n${JSON.stringify({
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

/** WHAT: Resolves one alert to its pane and prompt. WHY: Prevents owner reminders from falling back to the broker. */
export function watchdogAlertDelivery(projectId, alert, bootstrap, broker) {
  return { ...alertTarget(alert, broker), prompt: alertPrompt(projectId, alert, bootstrap) };
}

/** WHAT: Builds one owner gate message. WHY: Keeps approval and safety blockers distinct for the operator. */
export function ownerGateMessage(projectId, alert) {
  const gate = alert.payload?.gate === "safety-hold" ? "a safety review" : "your approval";
  const waitingMs = Number(alert.payload?.unownedForMs);
  const days = Number.isFinite(waitingMs) ? Math.floor(waitingMs / 86_400_000) : 0;
  return `[${projectId}/${alert.ticketId}] READY and unclaimed, waiting on ${gate}.`
    + " No agent can take it until you open that gate."
    + ` priority=${alert.payload?.priority ?? "unknown"}; waiting ${days}d.`;
}

/** WHAT: Builds one human notification receipt. WHY: Keeps direct owner delivery on the exact outbox identity. */
export function ownerNotificationReceipt(idempotencyKey, acknowledgedAt) {
  return { status: "acknowledged", acknowledgedAt,
    jobId: createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32) };
}

/** WHAT: Checks one acknowledged delivery receipt. WHY: Prevents approximate delivery from clearing the server outbox. */
export function validateReceipt(value, idempotencyKey) {
  if (!isObject(value) || value.status !== "acknowledged"
    || typeof value.jobId !== "string" || !/^[a-f0-9]{32}$/u.test(value.jobId)
    || !Number.isSafeInteger(value.acknowledgedAt) || value.acknowledgedAt < 0) {
    throw new Error("delivery: exact acknowledged agentmux receipt required");
  }
  return { idempotencyKey, jobId: value.jobId, status: "acknowledged",
    acknowledgedAt: Number(value.acknowledgedAt) };
}
