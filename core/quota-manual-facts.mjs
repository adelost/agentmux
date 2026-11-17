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

/** WHAT: Names each kind of free reset with its count, " (1 weekly, 1 fable)". WHY: Keeps a model's reset distinct from a whole week. */
const resetKinds = (resets) => {
  if (!Array.isArray(resets) || !resets.length) return "";
  const counts = new Map();
  for (const { kind } of resets) counts.set(kind, (counts.get(kind) || 0) + 1);
  return ` (${[...counts].map(([kind, count]) => `${count} ${kind}`).join(", ")})`;
};

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
    add("freeResetsLeft", `free resets ${s.freeResetsLeft}${resetKinds(s.limitResets)}${expiry ? ` · first expires ${expiry}` : ""}`,
      s.freeResetsReadAt || s.freeResetsReadOn);
  }
  if (s.planTier) add("planTier", `plan ${s.planTier}`, s.planReadAt);
  if (Number.isFinite(s.creditsBalance)) add("creditsBalance", `credits ${s.creditsBalance} (page observation)`, s.creditsReadAt);
  if (typeof s.autoReload === "boolean") add("autoReload", `auto-reload ${s.autoReload ? "on" : "off"}`, s.autoReloadReadAt);
  return facts;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-02T10:47:00Z" and "2026-11-02" are both "2 Nov": the day as it was written down. */
const dayMonth = day => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;

/** WHAT: Formats when a manual fact was read: nothing while fresh, its day once stale, a question mark when unknown. WHY: Keeps a dated billing fact from reading as current in the short box. */
const shortRead = (readAt, now) => !manualFactAge(readAt, now).stale ? ""
  : Number.isFinite(Date.parse(readAt)) ? ` (read ${dayMonth(readAt)})` : " (read ?)";

// 17 Nov 2026: the box carried every fact's full line with its ISO reading time, passed Discord's 2000 characters and no
// quota warning reached him; the full lines stand in amux quota's detail.
/** WHAT: Formats the renewal day and the free resets as the quota box's short lines. WHY: Keeps the box inside one phone-width Discord message. */
export function shortSubscriptionFacts(subscription = {}, now = Date.now()) {
  const s = subscription || {}, lines = [];
  if (s.renewsOn) {
    const passed = s.renewsOn < new Date(now).toLocaleDateString("en-CA");
    lines.push(`${passed ? `renewed ${dayMonth(s.renewsOn)}, PASSED` : `renews ${dayMonth(s.renewsOn)}`}${shortRead(s.renewsReadAt, now)}`);
  }
  if (Number.isInteger(s.freeResetsLeft)) {
    const first = s.freeResetsLeft > 0 && s.freeResetsExpire?.[0] ? `, ${s.freeResetsLeft === 1 ? "" : "1st "}ends ${dayMonth(s.freeResetsExpire[0])}` : "";
    lines.push(`${s.freeResetsLeft} free reset${s.freeResetsLeft === 1 ? "" : "s"}${resetKinds(s.limitResets)}${first}${shortRead(s.freeResetsReadAt || s.freeResetsReadOn, now)}`);
  }
  return lines;
}

/** WHAT: Formats a dated manual fact. WHY: Keeps its value and freshness inseparable. */
export const manualFactText = fact => `${fact.text} (${fact.ageText})`;
