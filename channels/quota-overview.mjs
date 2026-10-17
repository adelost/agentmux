// The quota overview the human reads: one block per engine, then one recommendation.
// Mattias 2026-10-17: "varför inte bara ge mig en tydlig över blick med vilken är vald på båda och hur mcyekt är kvar..
// och hur mycket som vinns på de andra.. sen i sluten ren rekmendation" and "är bättr epå engelska har jag reedan sagt".
import { weeklyForecast } from "../core/quota-forecast.mjs";
import { clockOf, formatNoticeTime } from "../core/quota-format.mjs";

const HOUR = 3_600_000;
const PLAN_NAMES = { free: "Free", plus: "Plus", pro: "Pro", prolite: "Pro Lite", max: "Max", team: "Team", enterprise: "Enterprise" };
const loginOf = account => String(account.account?.email || account.profile?.label || "unknown").split("@")[0].split(".").at(-1);
const planOf = account => account.account?.plan ? ` (${PLAN_NAMES[account.account.plan] || account.account.plan})` : "";
const list = panes => panes.join(", ");

// Display order, names, the page that shows a free reset, and the command that moves panes to another account.
// The usage page is the one Codex 0.163 itself links when the limit is hit.
const ENGINES = [
  { provider: "codex", title: "Codex", usagePage: "chatgpt.com/settings/usage",
    name: account => `Codex ${account.profile?.id} ${loginOf(account)}`,
    switchable: account => /^[12]$/u.test(String(account.profile?.id)),
    advise: (target, panes) => `\`//switch ${target.profile.id}\` in the channels of ${list(panes)} moves them to Codex ${target.profile.id} ${loginOf(target)}` },
  { provider: "claude", title: "Claude", usagePage: "claude.ai/settings/usage",
    name: account => `Claude ${loginOf(account)}`,
    switchable: () => true,
    advise: (target, panes) => `\`/byt ${loginOf(target)}\`, then \`/byt ${loginOf(target)} ok\`, moves ${list(panes)} to Claude ${loginOf(target)}` },
];

/** WHAT: Extracts the account's weekly quota. WHY: Prevents short and scoped windows from triggering warnings. */
export function weeklyQuotaOf(account) {
  if (!account?.ok) return null;
  if (account.provider === "claude") return account.limits?.find(limit => limit.kind === "weekly_all") || null;
  if (account.provider === "codex") return (account.limits?.find(limit => limit.limitId === "codex")
    || account.limits?.[0])?.windows?.find(window => window.windowMinutes === 10080) || null;
  return null;
}

const readableWeek = (account, now) => Number.isFinite(weeklyQuotaOf(account)?.usedPercent) && Date.parse(weeklyQuotaOf(account).resetsAt) > now;

/** WHAT: Measures one account's week and when it runs out at the recent pace. WHY: Gives every line the same facts. */
function weekFacts(account, { now, readingsOf }) {
  const panes = [...new Set(account.inUse || [])], active = [...new Set(account.activeInUse || [])];
  // A failed read stays visible on its line; it never counts as room or as running out.
  if (!readableWeek(account, now)) return { account, unreadable: true, usedPercent: null, resetAt: null, runsOutAt: null, panes, active };
  const weekly = weeklyQuotaOf(account), resetAt = Date.parse(weekly.resetsAt), usedPercent = Math.round(weekly.usedPercent);
  const latest = { at: Date.parse(account.observation?.observedAt) || now, usedPercent: weekly.usedPercent, resetsAt: weekly.resetsAt };
  const forecast = usedPercent < 100 && resetAt > now ? weeklyForecast({ history: readingsOf(account), latest, now }) : null;
  const runsOutAt = usedPercent >= 100 ? now : forecast?.pace && !forecast.lastsUntilReset ? forecast.exhaustAt : null;
  return { account, usedPercent, resetAt, runsOutAt, panes, active };
}

const sameDay = (left, right) => left.toDateString() === right.toDateString();
/** WHAT: Phrases when the week runs out, to the hour. WHY: Keeps a forecast readable and from changing every minute. */
function runOutPhrase(facts, now) {
  if (facts.usedPercent >= 100) return "used up";
  if (facts.runsOutAt === null) return "lasts until reset";
  const at = new Date(Math.round(facts.runsOutAt / HOUR) * HOUR), tomorrow = new Date(now + 24 * HOUR);
  if (at.getTime() <= now) return "runs out within the hour";
  if (sameDay(at, new Date(now))) return `runs out ~${clockOf(at)} today`;
  return sameDay(at, tomorrow) ? `runs out ~${clockOf(at)} tomorrow` : `runs out ~${formatNoticeTime(at)}`;
}

/** WHAT: Builds one engine's lines: the account its panes use, then the others. WHY: Shows what is selected and what the rest add. */
function engineBlock(engine, facts, now) {
  const busiest = [...facts].sort((a, b) => b.panes.length - a.panes.length)[0];
  const inUse = busiest?.panes.length ? busiest : null;
  const usage = (fact, tail) => fact.unreadable ? "usage not readable right now"
    : `${fact.usedPercent}% · resets ${formatNoticeTime(fact.resetAt)} · ${tail(fact)}`;
  const head = inUse ? `${engine.title}: in use ${engine.name(inUse.account)}${planOf(inUse.account)} · ${usage(inUse, fact => runOutPhrase(fact, now))}`
    : `${engine.title}: no panes`;
  const others = facts.filter(fact => fact !== inUse).map(fact => `  ${engine.name(fact.account)}${planOf(fact.account)} · `
    + usage(fact, ({ usedPercent }) => `adds ${Math.max(0, 100 - usedPercent)}%`) + (fact.panes.length ? ` · in use by ${list(fact.panes)}` : ""));
  return { engine, facts, inUse, lines: [head, ...others] };
}

/**
 * WHAT: Picks the one action for the account with working panes that runs out first.
 * WHY: Mattias wants a single clean recommendation last, never about an account no pane works on (07:18Z).
 */
function recommendation(blocks, { config, now }) {
  const urgent = blocks.flatMap(block => block.facts.filter(fact => fact.active.length && fact.runsOutAt != null)
    .map(fact => ({ ...block, fact }))).sort((a, b) => a.fact.runsOutAt - b.fact.runsOutAt)[0];
  if (!urgent) return "Recommendation: no action needed.";
  const { engine, facts, fact } = urgent;
  const spare = facts.filter(other => other !== fact && engine.switchable(other.account) && other.resetAt > now
    && other.usedPercent < config.warnPercent).sort((a, b) => a.usedPercent - b.usedPercent)[0];
  if (spare) return `Recommendation: ${engine.advise(spare.account, fact.panes)}.`;
  return `Recommendation: free reset for ${engine.name(fact.account)} at ${engine.usagePage} `
    + `${fact.usedPercent >= 100 ? "now" : "when it hits 100%"}.`;
}

/**
 * WHAT: Formats the whole overview and the facts that decide whether an edit is worth it.
 * WHY: Keeps one readable notice for both engines, and keeps a minute-by-minute forecast from editing it.
 */
export function buildQuotaOverview(snapshot, { config, now = Date.now(), readingsOf = () => [] }) {
  const accounts = (snapshot?.accounts || []).filter(account => readableWeek(account, now)
    || (account.account?.email && account.inUse?.length));
  const blocks = ENGINES.map(engine => accounts.filter(account => account.provider === engine.provider)
    .map(account => weekFacts(account, { now, readingsOf })).sort((a, b) => engine.name(a.account).localeCompare(engine.name(b.account))))
    .map((facts, index) => facts.length ? engineBlock(ENGINES[index], facts, now) : null).filter(Boolean);
  const advice = recommendation(blocks, { config, now });
  const fingerprint = JSON.stringify([blocks.flatMap(block => block.facts.map(fact => [block.engine.name(fact.account),
    fact.usedPercent, fact.panes.length, Math.round(fact.resetAt / HOUR)])), advice]);
  return { text: [...blocks.flatMap(block => block.lines), advice].join("\n"), fingerprint };
}
