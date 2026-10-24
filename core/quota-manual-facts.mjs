// Billing-page observations are independent of a fresh usage endpoint response.
const DAY = 86_400_000;

/** WHAT: Returns the age of a manual fact. WHY: Prevents a fresh quota fetch from refreshing billing evidence. */
export function manualFactAge(readAt, now) {
  const at = typeof readAt === "string" ? Date.parse(readAt) : NaN;
  const elapsed = now - at;
  if (!Number.isFinite(at) || elapsed < 0) return { stale: true, text: "STALE · read unknown · age unknown" };
  const age = elapsed < 3_600_000 ? `${Math.floor(elapsed / 60_000)}m` : `${Math.floor(elapsed / 3_600_000)}h`;
  return { stale: elapsed > DAY, text: `${elapsed > DAY ? "STALE · " : ""}manual read ${readAt} · age ${age}` };
}

/** WHAT: Formats only manually observed subscription facts. WHY: Keeps age and invalid renewal dates visible on both quota surfaces. */
export function manualSubscriptionFacts(subscription = {}, now = Date.now()) {
  const s = subscription || {}, facts = [];
  const add = (field, text, at) => {
    const age = manualFactAge(at, now);
    facts.push({ field, text, stale: age.stale, ageText: age.text });
  };
  if (s.renewsOn) {
    const today = new Date(now).toLocaleDateString("en-CA");
    add("renewsOn", `renews ${s.renewsOn}${s.renewsOn < today ? " · INVALID: renewal date has passed" : ""}`, s.renewsReadAt);
  }
  if (Number.isInteger(s.freeResetsLeft)) {
    const expiry = s.freeResetsExpire?.[0];
    add("freeResetsLeft", `free resets ${s.freeResetsLeft}${expiry ? ` · first expires ${expiry}` : ""}`,
      s.freeResetsReadAt || s.freeResetsReadOn);
  }
  if (s.planTier) add("planTier", `plan ${s.planTier}`, s.planReadAt);
  if (Number.isFinite(s.creditsBalance)) add("creditsBalance", `credits ${s.creditsBalance} (page observation)`, s.creditsReadAt);
  if (typeof s.autoReload === "boolean") add("autoReload", `auto-reload ${s.autoReload ? "on" : "off"}`, s.autoReloadReadAt);
  return facts;
}

/** WHAT: Formats a dated manual fact. WHY: Keeps its value and freshness inseparable. */
export const manualFactText = fact => `${fact.text} (${fact.ageText})`;
