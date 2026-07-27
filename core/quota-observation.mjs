// Shared subscription-quota observation contract.
//
// `observedAt` is when the provider-facing read completed. It is never the
// Suggestions receipt time or a UI render clock.

/** WHAT: Defines provider observation schema. WHY: Keeps incompatible snapshots from looking current. */
export const QUOTA_OBSERVATION_SCHEMA_VERSION = 1;
/** WHAT: Defines collection cadence. WHY: Keeps stale boundaries equal across clients. */
export const QUOTA_REFRESH_INTERVAL_MS = 15 * 60_000;

/** WHAT: Normalizes quota percentages. WHY: Keeps malformed provider values out of displays. */
export const clampQuotaPercent = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(100, Math.max(0, Math.round(numeric * 10) / 10));
};

/** WHAT: Builds one provider-timed observation. WHY: Keeps receipt clocks from masquerading as usage. */
export function quotaObservation({ source, observedAt, usedPercent, resetsAt }) {
  const observedMs = Date.parse(String(observedAt || ""));
  const used = clampQuotaPercent(usedPercent);
  if (!Number.isFinite(observedMs) || used === null) return null;
  return {
    schemaVersion: QUOTA_OBSERVATION_SCHEMA_VERSION,
    source,
    observedAt: new Date(observedMs).toISOString(),
    refreshIntervalMs: QUOTA_REFRESH_INTERVAL_MS,
    usedPercent: used,
    remainingPercent: Math.round((100 - used) * 10) / 10,
    resetsAt: typeof resetsAt === "string" ? resetsAt : null,
  };
}
