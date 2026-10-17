// The quota box the human reads: each account's week, then at most one action.
// Mattias 2026-10-17 11:39Z: "vilket konto har jag valt för Codex just nu och vilket konto är valt för Claude just nu. Och när
// resetas de och hur många procentare kvar. Och sen hur många, hur, ja, hur ser det ut på de andra kontona?"; 12:03Z: "Undvik
// emoji..."; 12:04Z: "jag vill nog både ha full restet.. inte bara 5h.. fll reset är vitkigare för plaenring...".
// Layout from lsrc:0 the same day: the week leads, at most 32 characters a line. 14:17Z: "en siffra bredvid som säger hur många
// paneler som kör på den", "här ser man ju inte om man har resets kvar. Man ser inte när subscriptionen tar slut heller".
import { accountName, loginOfEmail } from "../core/account-names.mjs";
import { weeklyForecast } from "../core/quota-forecast.mjs";
import { clockOf, nearestMinute } from "../core/quota-format.mjs";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LOGGED_OUT = new Set(["login_expired", "credentials_expired", "credentials_unavailable", "login_required"]);
const codexWindows = account => (account.limits?.find(limit => limit.limitId === "codex") || account.limits?.[0])?.windows || [];

// Each engine's five-hour window and the command that moves its panes to another of its accounts.
const ENGINES = [
  { provider: "codex", fiveHour: account => codexWindows(account).find(window => window.windowMinutes === 300) || null,
    switchCommand: target => `//switch ${target.profile.id}` },
  { provider: "claude", fiveHour: account => account.limits?.find(limit => limit.kind === "session") || null,
    switchCommand: target => `/byt ${loginOfEmail(target.account.email)}` },
];

/** WHAT: Extracts the account's weekly quota. WHY: Prevents short and scoped windows from triggering warnings. */
export function weeklyQuotaOf(account) {
  if (!account?.ok) return null;
  if (account.provider === "claude") return account.limits?.find(limit => limit.kind === "weekly_all") || null;
  if (account.provider === "codex") return codexWindows(account).find(window => window.windowMinutes === 10080) || null;
  return null;
}

/** WHAT: Formats a reset as "Sat 13:35". WHY: A weekly reset is less than a week away, so its weekday names the day. */
function dayAndClock(resetsAt) {
  const at = nearestMinute(resetsAt);
  return `${WEEKDAYS[at.getDay()]} ${clockOf(at)}`;
}

/** WHAT: Formats a time within hours, with its weekday only when it is not today. WHY: Keeps the five-hour line short. */
function untilClock(resetsAt, now) {
  const at = nearestMinute(resetsAt);
  return at.toDateString() === new Date(now).toDateString() ? clockOf(at) : dayAndClock(resetsAt);
}

const working = account => account.activeInUse ?? account.inUse ?? [];
const isIdleLoggedOut = account => !account.ok && LOGGED_OUT.has(account.error) && !account.inUse?.length;

// Mattias 2026-10-10: "tänk dock på att inte byta i onödan.. pga cache miss", so only a week that ends before its reset is advised on.
/** WHAT: Tells whether a week runs out before its reset at the last day's pace. WHY: Keeps a slow 80 % week from being told to switch. */
function runsOutBeforeReset(account, week, { now, readingsOf }) {
  const latest = { at: Date.parse(account.observation?.observedAt) || now, usedPercent: week.usedPercent, resetsAt: week.resetsAt };
  const forecast = weeklyForecast({ history: readingsOf(account), latest, now });
  return Boolean(forecast.pace) && !forecast.lastsUntilReset;
}

/** WHAT: Collects what one account's lines and the action need. WHY: Keeps every rule reading the same week and five-hour window. */
function accountFact(engine, account, shown, context) {
  const week = weeklyQuotaOf(account), fiveHour = account.ok ? engine.fiveHour(account) : null;
  const usable = week && Date.parse(week.resetsAt) > context.now ? week : null;
  return { engine, account, name: accountName(account, shown), week: usable,
    runsOut: Boolean(usable) && (usable.usedPercent >= 100 || runsOutBeforeReset(account, usable, context)),
    blockedBy5h: fiveHour?.usedPercent >= 100 && Date.parse(fiveHour.resetsAt) > context.now ? fiveHour : null };
}

/** WHAT: Phrases the renewal date and free resets the login's entry holds, or nothing. WHY: Keeps a renewal from being forgotten. */
function subscriptionLine({ renewsOn, freeResetsLeft } = {}) {
  const day = renewsOn ? new Date(`${renewsOn}T12:00:00Z`) : null;
  const parts = [...(day ? [`renews ${MONTHS[day.getUTCMonth()]} ${day.getUTCDate()}`] : []),
    ...(Number.isInteger(freeResetsLeft) ? [`${freeResetsLeft} free reset${freeResetsLeft === 1 ? "" : "s"}`] : [])];
  return parts.length ? [`  ${parts.join(" · ")}`] : [];
}

/** WHAT: Phrases one account's panes and week, its blocking five-hour window and its subscription. WHY: The week is what he plans by. */
function linesOf(fact, width, now) {
  const head = `${fact.name.padEnd(width)} ${String(fact.account.inUse?.length || 0).padStart(5)}`;
  if (!fact.week) return [`${head}  unreadable`, ...subscriptionLine(fact.account.subscription)];
  const left = Math.max(0, Math.min(100, Math.round(100 - fact.week.usedPercent)));
  return [`${head}  ${`${left}%`.padStart(4)}  ${dayAndClock(fact.week.resetsAt)}`,
    ...(fact.blockedBy5h ? [`    5h 0% until ${untilClock(fact.blockedBy5h.resetsAt, now)}`] : []),
    ...subscriptionLine(fact.account.subscription)];
}

/** WHAT: Finds the engine's other account with the most room that nothing stops now. WHY: A switch is only advice when it helps. */
function spareFor(fact, facts, config) {
  return facts.filter(other => other.engine === fact.engine && other.account !== fact.account && other.week && !other.blockedBy5h
    && other.week.usedPercent < config.warnPercent).sort((a, b) => a.week.usedPercent - b.week.usedPercent)[0] || null;
}

/** WHAT: Chooses the one action for the account in use that is stopped now, else the one working nearest a limit it reaches. WHY: Mattias wants a clean recommendation last, or none. */
function actionLine(facts, { config, now }) {
  const stopped = facts.filter(fact => fact.account.inUse?.length && (fact.blockedBy5h || fact.week?.usedPercent >= 100));
  const nearing = facts.filter(fact => working(fact.account).length && fact.week?.usedPercent >= config.warnPercent
    && fact.week.usedPercent < 100 && fact.runsOut).sort((a, b) => b.week.usedPercent - a.week.usedPercent);
  const fact = [...stopped, ...nearing][0];
  if (!fact) return null;
  const spare = spareFor(fact, facts, config);
  if (spare) return `→ Use ${spare.name}: ${fact.engine.switchCommand(spare.account)}`;
  // A free reset clears the week; a five-hour window comes back by itself.
  if (fact.week?.usedPercent >= 100) return `→ Free reset ${fact.name} now`;
  if (fact.blockedBy5h) return `→ ${fact.name} back at ${untilClock(fact.blockedBy5h.resetsAt, now)}`;
  return `→ Free reset ${fact.name} at 100%`;
}

/**
 * WHAT: Formats the quota box: every account's week as a monospace table, then one action or none.
 * WHY: Keeps what is left, when it resets and what to do in one view a phone can read.
 */
export function buildQuotaOverview(snapshot, { config, now = Date.now(), readingsOf = () => [] }) {
  const accounts = (snapshot?.accounts || []).filter(account => !isIdleLoggedOut(account));
  const shown = ENGINES.flatMap(engine => accounts.filter(account => account.provider === engine.provider)
    .sort((a, b) => (b.inUse?.length || 0) - (a.inUse?.length || 0)));
  const facts = shown.map(account => accountFact(ENGINES.find(engine => engine.provider === account.provider), account, shown, { now, readingsOf }));
  const width = Math.max(0, ...facts.map(fact => fact.name.length));
  const table = [`${" ".repeat(width)} panes  week  reset`, ...facts.flatMap(fact => linesOf(fact, width, now))];
  const action = actionLine(facts, { config, now });
  return { text: ["```", ...table, "```", ...(action ? [action] : [])].join("\n") };
}
