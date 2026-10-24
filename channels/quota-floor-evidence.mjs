import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readWindow } from "../core/ask-ledger.mjs";

/** WHAT: Reads sourced compact holds and backfills existing notices once. WHY: Keeps cache age unknown when only an old notice proves the hold. */
export function createQuotaCompactionEvidence({ configPath, posts = readWindow, now = Date.now }) {
  let historic = null;
  return jobs => {
    if (!jobs.length) return {};
    if (!historic) {
      historic = {};
      const agents = [...new Set(jobs.map(job => job.agentName))];
      for (const row of posts({ since: now() - 24 * 3600000, agents }).posts) {
        const match = /^Auto-compact of \*\*([^*]+)\*\* is held:.*context-cost:delivery-pending/u.exec(row.text || "");
        if (row.status !== "sent" || row.kind !== "notice" || !match || `${row.agent}:${row.pane}` !== match[1]) continue;
        const observedAt = Date.parse(row.ts), clock = /cache goes cold at (\d{2}):(\d{2})/u.exec(row.text);
        let cacheExpiresAt = null;
        if (clock) {
          const date = new Date(observedAt); date.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
          if (observedAt - date.getTime() > 12 * 3600000) date.setDate(date.getDate() + 1);
          cacheExpiresAt = date.getTime();
        }
        historic[match[1]] = { cause: "context-cost:delivery-pending", observedAt,
          source: `conversation:${row.id}`, lastActivityMs: null, cacheExpiresAt, cacheTimePrecision: "minute" };
      }
    }
    let current;
    try { current = JSON.parse(readFileSync(join(dirname(configPath), "compact-held-notices.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") current = {}; else throw error; }
    const result = { ...historic, ...(current.deliveryHolds || {}) };
    for (const [pane, value] of Object.entries(current)) {
      if (value?.cause?.includes("delivery-pending")) result[pane] = { ...value, source: `compact-held-notices:${pane}` };
    }
    return result;
  };
}
