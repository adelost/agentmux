const REQUESTS = "codex_account_requests_v1:", BATCHES = "codex_account_batches_v1:", RECEIPTS = "codex_account_receipts_v1:";
/** WHAT: Stores every intended pane before the first restart in one state transaction.
 * WHY: Prevents a CLI crash from leaving a partially registered fleet request. */
export function registerAccountSwitchBatch(state, { id, target, requestedAt, requests }) {
  const change = data => {
    if (data[`${BATCHES}${id}`]) {
      if (data[`${BATCHES}${id}`].target !== target) throw new Error("request-id already belongs to another target");
      return;
    }
    const members = {};
    for (const [key, request] of requests) {
      const previous = data[`${REQUESTS}${key}`];
      if (previous?.id && previous.id !== request.id) data[`${RECEIPTS}${previous.id}`] = previous;
      data[`${REQUESTS}${key}`] = request;
      members[key] = request.id;
    }
    data[`${BATCHES}${id}`] = { id, target, requestedAt, keys: requests.map(([key]) => key), requests: members };
  };
  if (state.updateAll) return state.updateAll(change);
  // In-memory test stores expose the same transaction through all/set.
  const data = state.all();
  change(data);
  for (const [key, value] of Object.entries(data)) state.set(key, value);
}

function requestRow(key, request, batchId) {
  const resultKind = request.result ? request.result.dormant ? "dormant-selected"
    : ["same", "switched"].includes(request.result.kind) ? "switched" : null : null;
  return { key, id: request.id, batchId: batchId || request.batchId || null, target: request.target,
    requestedAt: request.requestedAt, mode: request.result?.freshOnNextStart ? "fresh-next-start"
      : request.result?.fresh ? "fresh-handover" : request.result?.dormant ? "selected-next-start" : request.result ? "exact-session" : null,
    handoverPath: request.result?.handoverPath || null, sessionId: request.result?.sessionId || request.result?.status?.status?.session || null,
    phase: request.phase, reason: request.reason || null, resultKind,
    status: request.phase === "complete" ? resultKind === "dormant-selected" ? "selected-for-next-start" : "switched"
      : request.phase === "blocked" ? "blocked" : "pending" };
}

/** WHAT: Reads current or batch-scoped account requests without process or state mutation. WHY: Keeps a host restart from requiring a second switch command. */
export function accountSwitchStatus(ctx, { requestId = null } = {}) {
  const data = ctx.state.all?.() || null;
  const batch = requestId ? ctx.state.get(`${BATCHES}${requestId}`, null) : null;
  const current = data ? Object.entries(data).filter(([key]) => key.startsWith(REQUESTS))
    .map(([key, request]) => [key.slice(REQUESTS.length), request]) : [];
  const entries = requestId ? Object.entries(batch?.requests || {}).map(([key, id]) => {
    const request = ctx.state.get(`${REQUESTS}${key}`);
    return [key, request?.id === id ? request : ctx.state.get(`${RECEIPTS}${id}`)];
  }) : current;
  const rows = entries.filter(([, request]) => request).map(([key, request]) => requestRow(key, request, requestId));
  const summary = { total: batch?.keys?.length ?? rows.length, pending: 0, blocked: 0, complete: 0, switched: 0, dormantSelected: 0 };
  for (const row of rows) {
    summary[row.phase === "complete" ? "complete" : row.phase === "blocked" ? "blocked" : "pending"]++;
    if (row.phase === "complete" && row.resultKind === "switched") summary.switched++;
    if (row.phase === "complete" && row.resultKind === "dormant-selected") summary.dormantSelected++;
  }
  summary.pending += Math.max(0, summary.total - rows.length);
  const found = !requestId || Boolean(batch);
  const status = !found ? "NOT_FOUND" : summary.pending ? "PENDING" : summary.blocked
    ? summary.complete ? "PARTIAL" : "BLOCKED" : "COMPLETE";
  return { schemaVersion: 1, status, found, batchId: requestId, target: batch?.target || null,
    requestedAt: batch?.requestedAt || null, observedAt: new Date().toISOString(), rows, summary };
}

/** WHAT: Builds machine-readable or operator-readable durable switch status. WHY: Keeps polling read-only and preserves the existing human CLI. */
export function switchStatusCommand(ctx, args, { output = console.log } = {}) {
  let json = false, requestId = null;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--json") json = true;
    else if (args[index] === "--request-id" && args[index + 1]) requestId = args[++index];
    else throw new Error(`invalid switch-status argument: ${args[index]}`);
  }
  const result = accountSwitchStatus(ctx, { requestId });
  if (json) output(JSON.stringify(result));
  else for (const row of result.rows) output(`${row.key} ${row.status}${row.mode === "fresh-next-start" ? " (saved handover, fresh on next start)" : row.reason ? ` (${row.reason})` : ""}`);
  return result;
}
