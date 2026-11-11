import { randomUUID } from "node:crypto";

// Durable operator requests and their read-only receipts.
/** WHAT: Names a pane's Claude rotation request. WHY: Keeps unrelated pane requests in separate keys. */
export const claudeRotationKey = (name, pane) => `claude_account_request_v1:${name}:${pane}`;
const receiptKey = id => `claude_account_receipt_v1:${id}`;

/** WHAT: Stores one session-bound rotation and its receipt atomically. WHY: Keeps an older retry from overwriting a newer request. */
export function saveClaudeRotation(state, request, expectedId = null, accepts = () => true) {
  const key = claudeRotationKey(request.name, request.pane);
  const write = data => {
    const prior = data[key];
    if ((prior?.id || null) !== expectedId || !accepts(prior)) return false;
    if (prior?.id && prior.id !== request.id) data[receiptKey(prior.id)] = prior.phase === "pending"
      ? { ...prior, phase: "superseded", reason: "newer-rotation" } : prior;
    data[key] = request;
    data[receiptKey(request.id)] = request;
    return true;
  };
  if (state.updateAll) return state.updateAll(write);
  const data = { [key]: state.get(key, null) };
  const saved = write(data);
  if (saved) for (const [field, value] of Object.entries(data)) state.set(field, value);
  return saved;
}

/** WHAT: Reads a saved rotation by id or pane. WHY: Keeps polling read-only and preserves an outcome after a newer request. */
export function claudeRotationStatus(state, { id = null, pane = null } = {}) {
  let request = id ? state.get(receiptKey(id), null) : state.get(`claude_account_request_v1:${pane}`, null);
  if (!request && id && state.all) request = Object.entries(state.all()).find(([key, value]) =>
    key.startsWith("claude_account_request_v1:") && value?.id === id)?.[1];
  return request ? { schemaVersion: 1, found: true, requestId: request.id, pane: `${request.name}:${request.pane}`,
    target: request.target, sessionId: request.sessionId || null, status: request.phase, outcome: request.outcome || null, reason: request.reason || null }
    : { schemaVersion: 1, found: false, requestId: id, pane, status: "not-found", outcome: null };
}

/** WHAT: Reports one saved rotation outcome. WHY: Keeps Stats and operators on the same durable status contract. */
export function claudeRotationStatusCommand(ctx, args, output = console.log) {
  let id = null, pane = null, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") json = true;
    else if (args[i] === "--request-id" && /^[\w-]{1,128}$/u.test(args[i + 1] || "")) id = args[++i];
    else if (args[i] === "--only" && /^[\w.-]+:\d+$/u.test(args[i + 1] || "")) pane = args[++i];
    else throw new Error(`invalid rotate-status option: ${args[i]}`);
  }
  if (Boolean(id) === Boolean(pane)) throw new Error("rotate-status requires --request-id ID or --only agent:pane");
  const result = claudeRotationStatus(ctx.state, { id, pane });
  output(json ? JSON.stringify(result) : `${result.pane || result.requestId} ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
  return result;
}

/** WHAT: Stores or reuses one exact-session switch episode. WHY: Keeps a busy retry bound to its compact outcome after more work. */
export function beginClaudeRotation(state, entry, target, identity, { automatic = false } = {}) {
  if (!state?.set || !identity?.sessionId || !identity.path) return null;
  const key = claudeRotationKey(entry.agentName, entry.pane), prior = state.get(key, null);
  if (automatic && prior?.phase === "pending" && prior.target !== target) return null;
  if (prior?.phase === "pending" && prior.target === target
      && prior.sessionId === identity.sessionId && prior.sessionPath === identity.path) {
    if (!automatic && prior.automatic) {
      const explicit = { ...prior, automatic: false };
      return saveClaudeRotation(state, explicit, prior.id) ? explicit : null;
    }
    return prior;
  }
  const request = { id: randomUUID(), phase: "pending", automatic, target,
    name: entry.agentName, pane: entry.pane, sessionId: identity.sessionId, sessionPath: identity.path };
  return saveClaudeRotation(state, request, prior?.id || null) ? request : null;
}

/** WHAT: Reads the compact belonging to this switch request and source account. WHY: Prevents another request, session or account from borrowing its boundary. */
export function rotationCompact(state, entry, request) {
  const current = request && state?.get?.(claudeRotationKey(entry.agentName, entry.pane), null);
  if (!current || !request || current.id !== request.id || current.sessionId !== entry.identity?.sessionId
      || current?.sessionPath !== entry.identity?.path || current?.target !== request?.target) return null;
  const proof = current.compact;
  return proof?.sourceProfileId === entry.currentProfile?.id ? proof : null;
}

/** WHAT: Saves a switch's compact claim or result on its existing receipt. WHY: Prevents activity or controller restart from unlocking an unknown provider outcome. */
export function saveRotationCompact(state, entry, request, compact) {
  if (!request) return true;
  const current = state.get(claudeRotationKey(entry.agentName, entry.pane), null);
  if (current?.id !== request.id) return false;
  return saveClaudeRotation(state, { ...current, compact: { ...compact, sourceProfileId: entry.currentProfile?.id } }, request.id,
    prior => compact.status === "attempting" ? !prior.compact || compactNeverSent(prior.compact)
      : !prior.compact || prior.compact.sourceProfileId === entry.currentProfile?.id
        && (prior.compact.status === "attempting" || prior.compact.status === "verified" && prior.compact.afterTokens === null
          && compact.status === "verified" && Number.isFinite(compact.afterTokens)));
}

// Releases before 2026-11-11 stored such a stop as unknown with the reason compact-skipped (skyvw:1 and lsrc:0 held on a spent account).
/** WHAT: Checks whether a switch compact stopped before it was sent. WHY: Lets the next rotation retry; a sent outcome keeps holding. */
export const compactNeverSent = proof => proof?.status === "skipped"
  || proof?.status === "unknown" && /^compact-skipped(?::|$)/u.test(proof.reason || "");

/** WHAT: Stores the original rotation request. WHY: Keeps busy retries on one identity and preserves successful outcomes. */
export function finishClaudeRotations(state, rows, requests) {
  for (const row of rows) {
    const request = requests.get(row.key), key = `claude_account_request_v1:${row.key}`;
    const current = request && state.get(key, null);
    if (current?.id !== request?.id || !current) continue;
    const success = ["switched", "already-selected", "selected-for-quota-recovery", "selected-for-next-wake"].includes(row.status);
    const phase = row.status === "blocked" ? current.phase : success ? "complete" : "blocked";
    if (saveClaudeRotation(state, { ...current, phase, outcome: row.status === "blocked" ? null : row.status,
      reason: row.reason || null }, request.id, live => JSON.stringify(live.compact) === JSON.stringify(current.compact)) && row.status === "blocked" && phase === "pending" && !current.automatic) row.followupId = request.id;
  }
}
