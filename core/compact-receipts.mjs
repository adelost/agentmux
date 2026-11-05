/** WHAT: Names the shared compact receipt store. WHY: Keeps every trigger's evidence in one state key. */
export const COMPACT_RECEIPTS_STATE = "context_maintenance_by_pane_v1";
/** WHAT: Defines the compact writer timeout. WHY: Keeps stale attempts from remaining in flight indefinitely. */
export const COMPACT_WRITER_LIFETIME_MS = 40 * 60_000;
const processAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

/** WHAT: Checks whether the compact writer has gone. WHY: Prevents a live model call from being reclassified as abandoned. */
export function compactWriterGone(record, { now = Date.now(), alive = processAlive, self = process.pid } = {}) {
  if (record.pid === self) return false;
  if (record.pid && !alive(record.pid)) return true;
  return Number.isFinite(record.at) && now - record.at > COMPACT_WRITER_LIFETIME_MS;
}

/** WHAT: Reads one pane's compact record. WHY: Keeps all triggers on the same receipt. */
export function compactReceipt(state, pane) {
  return state?.get?.(COMPACT_RECEIPTS_STATE, {})?.[pane] || null;
}

/** WHAT: Stores one compact record atomically. WHY: Keeps quota history when another trigger changes the current attempt. */
export function updateCompactReceipt(state, pane, change) {
  const update = records => {
    const next = { ...(records || {}) };
    next[pane] = change(next[pane] || {});
    return next;
  };
  if (state.updateKey) return state.updateKey(COMPACT_RECEIPTS_STATE, update);
  return state.set(COMPACT_RECEIPTS_STATE, update(state.get(COMPACT_RECEIPTS_STATE, {})));
}

/** WHAT: Reads quota attempts for one episode from compact receipts. WHY: Keeps quota notices and admission on the same history. */
export function quotaCompactRecords(state, episode) {
  const records = state?.get?.(COMPACT_RECEIPTS_STATE, {}) || {}, result = {};
  for (const pane of episode?.panes || []) {
    const attempts = records[pane]?.quotaCompactions?.[episode.id] || episode.warmCompactions?.[pane]?.attempts;
    if (attempts?.length) result[pane] = { attempts };
  }
  return result;
}

/** WHAT: Resolves an episode's legacy and expired attempts in the shared store. WHY: Prevents a timed-out quota compact from being repeated as a new attempt. */
export function reconcileQuotaCompactions(state, episode, now, quotaStateKey) {
  const attempts = quotaCompactRecords(state, episode);
  const expired = Object.values(attempts).some(record => record.attempts.some(item => item.status === "attempting"
    && Number.isFinite(item.at) && now - item.at >= COMPACT_WRITER_LIFETIME_MS));
  if (!state?.updateAll || !expired && !episode?.warmCompactions) return;
  state.updateAll(data => {
    const live = Object.values(data[quotaStateKey]?.accounts || {}).find(item => item.id === episode.id);
    if (!live) return;
    const records = data[COMPACT_RECEIPTS_STATE] ||= {};
    for (const pane of new Set([...(live.panes || []), ...Object.keys(live.warmCompactions || {})])) {
      const old = live.warmCompactions?.[pane]?.attempts;
      const existing = records[pane]?.quotaCompactions?.[live.id];
      if (!old && !existing) continue;
      const record = records[pane] ||= {};
      record.quotaCompactions ||= {};
      const history = record.quotaCompactions[live.id] ||= old || [];
      for (const item of old || []) if (!history.some(saved => saved.at === item.at && saved.number === item.number
          && saved.sessionId === item.sessionId)) history.push(item);
      for (const item of history) if (item.status === "attempting" && Number.isFinite(item.at)
          && now - item.at >= COMPACT_WRITER_LIFETIME_MS) {
        const proven = record.sessionId === item.sessionId && record.quotaClaim?.episodeId === live.id
          && record.quotaClaim?.at === item.at && record.quotaClaim?.number === item.number;
        item.status = proven && record.status === "VERIFIED" ? "verified"
          : proven && record.status === "MEASURED" ? "measured" : "unknown";
        item.reason = "compact-attempt-timeout";
        item.finishedAt = now;
      }
      if (live.warmCompactions) delete live.warmCompactions[pane];
    }
    if (live.warmCompactions && !Object.keys(live.warmCompactions).length) delete live.warmCompactions;
  });
}

/** WHAT: Resolves an expired compact from a fresh exact-session reading or marks it unknown. WHY: Keeps a stopped writer from holding an attempting receipt forever. */
export function resolveExpiredCompact(state, pane, { identity = null, reading = null, now = Date.now(), alive = processAlive } = {}) {
  const before = compactReceipt(state, pane);
  const eligible = before?.status === "ATTEMPTING" || before?.status === "UNKNOWN" && before.reason === "compact-attempt-timeout";
  if (!eligible || !Number.isFinite(before.at) || now - before.at < COMPACT_WRITER_LIFETIME_MS) return before;
  const observedAt = Date.parse(reading?.observedAt);
  const samePath = identity?.path && (before.sessionPath === identity.path || before.cursor?.positions?.[identity.path] != null);
  const measured = (!before.pid || !alive(before.pid)) && identity?.sessionId === before.sessionId
    && samePath && reading?.sessionId === before.sessionId
    && Number.isFinite(reading?.tokens) && reading.tokens >= 0 && Number.isFinite(observedAt) && observedAt >= before.at;
  let result = before;
  updateCompactReceipt(state, pane, current => {
    if (current.at !== before.at || current.sessionId !== before.sessionId || current.status !== before.status) return current;
    result = { ...current, status: measured ? "MEASURED" : "UNKNOWN", afterTokens: measured ? reading.tokens : null,
      ...(current.nightlyStatus === "attempting" && { nightlyStatus: measured ? "measured" : "unverified" }),
      reason: measured ? "compact-attempt-measured" : "compact-attempt-timeout", resolvedAt: now };
    return result;
  });
  return result;
}

/** WHAT: Resolves timed-out compact intents during the existing heartbeat. WHY: Keeps idle panes from retaining an attempting marker indefinitely. */
export function expireCompactReceipts(state, now) {
  for (const [pane, record] of Object.entries(state?.get?.(COMPACT_RECEIPTS_STATE, {}) || {})) {
    if (record?.status === "ATTEMPTING" && Number.isFinite(record.at) && now - record.at >= COMPACT_WRITER_LIFETIME_MS) {
      resolveExpiredCompact(state, pane, { now });
    }
  }
}
