// Durable operator requests and their read-only receipts.
/** WHAT: Names a pane's Claude rotation request. WHY: Keeps unrelated pane requests in separate keys. */
export const claudeRotationKey = (name, pane) => `claude_account_request_v1:${name}:${pane}`;
const receiptKey = id => `claude_account_receipt_v1:${id}`;

/** WHAT: Stores one session-bound rotation and its receipt atomically. WHY: Keeps an older retry from overwriting a newer request. */
export function saveClaudeRotation(state, request, expectedId = null) {
  const key = claudeRotationKey(request.name, request.pane);
  const write = data => {
    const prior = data[key];
    if ((prior?.id || null) !== expectedId) return false;
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
