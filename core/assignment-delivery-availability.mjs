import { looksDone } from "./orchestrator-checkpoint.mjs";
import { parseSenderHeader } from "./sender-detect.mjs";
import { isSystemNoiseDirective } from "./system-noise.mjs";

/** WHAT: Defines the sustained-idle assignment threshold. WHY: Keeps short pauses from looking like worker availability. */
export const DEFAULT_ASSIGNMENT_IDLE_MS = 10 * 60_000;

/** WHAT: Resolves whether one pane can receive a new assignment. WHY: Keeps unfinished work from being interrupted or stacked. */
export function assignmentDeliveryEligibility({ paneStatus, lastAssistantText = null,
  lastAssistantAt = null, lastUserAt = null, lastCoordinationAt = null, now = Date.now(),
  idleMs = DEFAULT_ASSIGNMENT_IDLE_MS }) {
  if (paneStatus !== "idle") return { eligible: false, reason: `pane-${paneStatus || "unknown"}` };
  const assistantAt = Number(lastAssistantAt), userAt = Number(lastUserAt), coordinationAt = Number(lastCoordinationAt);
  const hasAssistant = Number.isFinite(assistantAt) && assistantAt > 0;
  const hasUser = Number.isFinite(userAt) && userAt > 0, hasCoordination = Number.isFinite(coordinationAt) && coordinationAt > 0;
  if (!hasAssistant && !hasUser && !hasCoordination) return { eligible: false, reason: "no-turn-data", idleForMs: null };
  const answeredLatest = hasAssistant && assistantAt >= Math.max(hasUser ? userAt : 0, hasCoordination ? coordinationAt : 0);
  const explicitAvailable = String(lastAssistantText || "").trimEnd().split(/\r?\n/u).at(-1)?.trim() === "ASSIGNMENT_AVAILABLE";
  if (answeredLatest && (explicitAvailable || looksDone(lastAssistantText))) {
    return { eligible: true, reason: explicitAvailable ? "explicit-available" : "explicit-done", idleForMs: Math.max(0, now - assistantAt) };
  }
  const lastActivityAt = Math.max(hasAssistant ? assistantAt : 0, hasUser ? userAt : 0, hasCoordination ? coordinationAt : 0);
  const idleForMs = lastActivityAt > 0 ? Math.max(0, now - lastActivityAt) : 0;
  if (lastActivityAt > 0 && idleForMs >= idleMs) return { eligible: true, reason: "sustained-idle", idleForMs };
  const reason = hasCoordination && coordinationAt === lastActivityAt ? "recent-inter-agent-contact" : "idle-threshold-not-met";
  return { eligible: false, reason, idleForMs };
}

/** WHAT: Builds assignment presence from the real pane timeline. WHY: Separates owner activity, peer contact, and offer-protocol turns. */
export function assignmentDeliveryAvailability({ paneStatus, rows = [], agent, pane,
  now = Date.now(), idleMs = DEFAULT_ASSIGNMENT_IDLE_MS }) {
  let lastAssistantText = null, lastAssistantAt = null, lastUserAt = null;
  let lastCoordinationAt = null, offerTurn = false, offerTurnHasTool = false;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.agent !== agent || Number(row?.pane) !== Number(pane)) continue;
    const at = Date.parse(String(row.timestamp || ""));
    if (!Number.isFinite(at) || !String(row.content || "").trim()) continue;
    if (row.role === "user") {
      if (row.type != null && row.type !== "text") continue;
      offerTurn = /^(?:\[from [a-zA-Z0-9_-]+:\d+\]\r?\n(?:\r?\n)?)?ASSIGNMENT OFFER — [A-Z][A-Z0-9]*-\d{4,} — generation \d+(?:\r?\n|$)/u.test(String(row.content).trimStart());
      offerTurnHasTool = false;
      if (!offerTurn && !isSystemNoiseDirective(row.content)
        && (lastUserAt == null || at >= lastUserAt)) {
        lastUserAt = at;
        if (parseSenderHeader(row.content)) lastCoordinationAt = at;
      }
      continue;
    }
    if (row.role !== "assistant") continue;
    if (row.type === "tool") {
      if (offerTurn) offerTurnHasTool = true;
      [lastAssistantAt, lastAssistantText] = [at, ""];
      continue;
    }
    const explicitAvailable = String(row.content).trimEnd().split(/\r?\n/u).at(-1)?.trim()
      === "ASSIGNMENT_AVAILABLE";
    if ((row.type == null || row.type === "text")
      && (!offerTurn || offerTurnHasTool || explicitAvailable)
      && (lastAssistantAt == null || at >= lastAssistantAt)) {
      [lastAssistantAt, lastAssistantText] = [at, String(row.content)];
    }
  }
  return assignmentDeliveryEligibility({
    paneStatus, lastAssistantText, lastAssistantAt, lastUserAt, lastCoordinationAt, now, idleMs,
  });
}
