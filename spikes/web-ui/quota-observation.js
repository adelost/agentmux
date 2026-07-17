// Browser-only projection of quota-observation.v1.
// LOCKSTEP: suggestions-v1d/src/ops-quota.ts owns the other browser twin;
// both contract tests pin identical provider fields and stale boundaries.

const WARN_PERCENT = 70;
const CRITICAL_PERCENT = 90;

/** WHAT: Maps used quota to visual severity. WHY: Keeps compact and expanded Code views aligned. */
export const quotaSeverityClass = (usedPercent) => {
  if (usedPercent >= CRITICAL_PERCENT) return "critical";
  if (usedPercent >= WARN_PERCENT) return "warning";
  return "ok";
};

/** WHAT: Maps provider fields to a time-aware view. WHY: Keeps generated and receipt clocks out of freshness. */
export const quotaObservationView = (observation, now = Date.now()) => {
  const source = typeof observation?.source === "string" && observation.source
    ? observation.source : null;
  const observedAt = typeof observation?.observedAt === "string" ? observation.observedAt : null;
  const observedMs = observedAt == null ? NaN : Date.parse(observedAt);
  const interval = Number(observation?.refreshIntervalMs);
  const used = Number(observation?.usedPercent);
  const remaining = Number(observation?.remainingPercent);
  const valid = observation?.schemaVersion === 1 && source && Number.isFinite(observedMs)
    && Number.isFinite(interval) && interval > 0
    && Number.isFinite(used) && used >= 0 && used <= 100
    && Number.isFinite(remaining) && remaining >= 0 && remaining <= 100
    && Math.abs(100 - used - remaining) < 0.051;
  if (!valid) return { state: "unavailable", ageMs: null, source, observedAt,
    usedPercent: null, remainingPercent: null, resetsAt: null };
  const ageMs = Math.max(0, now - observedMs);
  if (ageMs >= 2 * interval) return { state: "stale", ageMs, source, observedAt,
    usedPercent: null, remainingPercent: null, resetsAt: null };
  return { state: "fresh", ageMs, source, observedAt,
    usedPercent: used, remainingPercent: remaining,
    resetsAt: typeof observation.resetsAt === "string" ? observation.resetsAt : null };
};

/** WHAT: Maps Suggest delivery health to a visible state. WHY: Keeps collection success from hiding push failure. */
export const quotaDeliveryView = (delivery) => {
  if (delivery?.previousHealth?.state === "alert") {
    return { state: "recovered", reason: delivery.previousHealth.reason
      || "suggestions-delivery-stale" };
  }
  if (delivery?.ok === true && delivery?.health?.state !== "alert") {
    return { state: "synced", reason: null };
  }
  return { state: "failed", reason: delivery?.health?.reason
    || delivery?.error || "suggestions-delivery-unavailable" };
};

const claudeLimitLabel = (limit) => {
  if (limit.kind === "session") return "Session (5 h)";
  if (limit.kind === "weekly_all") return "Week · all models";
  if (limit.kind === "weekly_scoped") return `Week · ${limit.scopeName || "model"}`;
  return limit.kind;
};

const codexWindowLabel = (window, limit) => {
  const scope = limit.limitId && limit.limitId !== "codex" ? ` · ${limit.limitId}` : "";
  if (window.windowMinutes === 10_080) return `Week${scope}`;
  if (window.windowMinutes && window.windowMinutes % 60 === 0) {
    return `${window.windowMinutes / 60} h${scope}`;
  }
  return `${window.windowMinutes ?? "?"} min${scope}`;
};

/** WHAT: Builds Code quota rows from one observation. WHY: Keeps headline values on provider truth. */
export const quotaRows = (engine, data, observation = quotaObservationView(data?.observation)) => {
  if (engine === "claude") {
    return (data.limits ?? []).map((limit) => {
      const primary = limit.kind === "weekly_scoped" && limit.scopeName === "Fable";
      const usedPercent = primary ? observation.usedPercent : limit.usedPercent;
      return {
        scope: primary ? "weekly-primary"
          : limit.kind === "weekly_all" ? "weekly" : "other",
        label: claudeLimitLabel(limit),
        usedPercent,
        remainingPercent: primary ? observation.remainingPercent : 100 - usedPercent,
        resetsAt: primary ? observation.resetsAt : limit.resetsAt,
      };
    });
  }
  const rows = (data.limits ?? []).flatMap((limit) => (limit.windows ?? []).map((window) => ({
      scope: window.windowMinutes === 10_080 ? "weekly-primary" : "other",
      label: codexWindowLabel(window, limit),
      usedPercent: window.usedPercent,
      remainingPercent: 100 - window.usedPercent,
      resetsAt: window.resetsAt,
      observedAt: observation.observedAt,
    })));
  if (observation.usedPercent == null) return rows;
  return [{ scope: "weekly-primary", label: "Week", usedPercent: observation.usedPercent,
    remainingPercent: observation.remainingPercent, resetsAt: observation.resetsAt,
    observedAt: observation.observedAt }, ...rows.filter((row) => row.scope !== "weekly-primary")];
};

/** WHAT: Resolves the structural headline row. WHY: Keeps translated labels out of quota priority. */
export const quotaHeadline = (rows) => rows.find((row) => row.scope === "weekly-primary")
  || rows.find((row) => row.scope === "weekly") || rows[0];

/** WHAT: Formats one reset instant. WHY: Keeps Code rows on one locale and wording. */
export const formatQuotaReset = (iso) => {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const formatted = date.toLocaleString("en-US", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
  return `resets ${formatted}`;
};

/** WHAT: Formats provider source and age. WHY: Keeps receipt time from looking measured. */
export const formatQuotaObservation = (observation) => observation?.source
  && observation?.ageMs != null
  ? `${observation.source} · measured ${Math.floor(observation.ageMs / 60_000)} min ago`
  : "provider observation unavailable";
