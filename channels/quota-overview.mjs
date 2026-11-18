// The quota box the human reads: each account's week, then at most one action.
// Mattias 2026-10-17 11:39Z: "vilket konto har jag valt för Codex just nu och vilket konto är valt för Claude just nu. Och när
// resetas de och hur många procentare kvar. Och sen hur många, hur, ja, hur ser det ut på de andra kontona?"; 12:03Z: "Undvik
// emoji..."; 12:04Z: "jag vill nog både ha full restet.. inte bara 5h.. fll reset är vitkigare för plaenring...".
// Layout from lsrc:0 the same day: the week leads, at most 32 characters a line. 14:17Z: "en siffra bredvid som säger hur många
// paneler som kör på den", "här ser man ju inte om man har resets kvar. Man ser inte när subscriptionen tar slut heller".
import { accountName, loginOfEmail } from "../core/account-names.mjs";
import { weeklyForecast } from "../core/quota-forecast.mjs";
import { clockOf, creditsText, nearestMinute } from "../core/quota-format.mjs";
import { manualSubscriptionFacts, shortSubscriptionFacts } from "../core/quota-manual-facts.mjs";
import { quotaFloorPercent } from "../core/quota-park.mjs";
import { fableFullWeekPoints, fableQuotaOf } from "../core/fable-quota.mjs";
export { fableQuotaOf } from "../core/fable-quota.mjs";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HOUR = 3_600_000, DAY = 24 * HOUR, PHONE_WIDTH = 32;
// Mattias to sandman:0 2026-11-15 06:25Z, after pressing Codex W's free reset on advice that did not show its week was back in
// three days: three days was worth a reset, two would have been doubtful.
const WAIT_WITHIN_MS = 2 * DAY;
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
function subscriptionLines(subscription, now) {
  return shortSubscriptionFacts(subscription, now).map(line => `  ${line}`);
}

/** WHAT: Phrases one account's panes and week, its blocking five-hour window and its subscription. WHY: The week is what he plans by. */
function linesOf(fact, width, now) {
  const subscription = fact.account.subscription;
  const head = `${fact.name.padEnd(width)} ${String(fact.account.inUse?.length || 0).padStart(5)}`;
  if (!fact.week) return [`${head}  unreadable`, ...subscriptionLines(subscription, now)];
  const left = Math.max(0, Math.min(100, Math.round(100 - fact.week.usedPercent)));
  return [`${head}  ${`${left}%`.padStart(4)}  ${dayAndClock(fact.week.resetsAt)}`,
    ...(fact.blockedBy5h ? [`    5h 0% until ${untilClock(fact.blockedBy5h.resetsAt, now)}`] : []),
    // lsrc:0 2026-10-20: past a spent window Codex draws these paid credits, so the balance stands beside the windows.
    ...(fact.account.credits ? [`    ${creditsText(fact.account.credits)}`] : []),
    ...subscriptionLines(subscription, now)];
}

/** WHAT: Finds the engine's other account with the most room that nothing stops now. WHY: A switch is only advice when it helps. */
function spareFor(fact, facts, config) {
  return facts.filter(other => other.engine === fact.engine && other.account !== fact.account && other.week && !other.blockedBy5h
    && other.week.usedPercent < config.warnPercent).sort((a, b) => a.week.usedPercent - b.week.usedPercent)[0] || null;
}

/** WHAT: Lists when the login's free weekly resets end, soonest first. WHY: A model's reset gives that model's allowance back, never the week. */
function weeklyResetEnds(subscription, now) {
  const listed = Array.isArray(subscription.limitResets)
    ? subscription.limitResets.filter(reset => reset.kind === "weekly").map(reset => reset.expires)
    : subscription.freeResetsExpire || [];
  return listed.map(end => Date.parse(end)).filter(end => end > now).sort((a, b) => a - b);
}

/** WHAT: Tells whether a free weekly reset is worth pressing now. WHY: Keeps a reset from being spent on a week that is back within two days, unless the reset itself ends first. */
const worthPressing = (weekBackAt, resetEnds, now) => weekBackAt - now > WAIT_WITHIN_MS || resetEnds[0] < weekBackAt;

/** WHAT: Phrases the facts a press is judged by: the week's own return and each reset's end. WHY: He decides on a limited reset, so what it buys stands above the verdict. */
function resetFactLines(weekBackAt, resetEnds, now) {
  const away = weekBackAt - now;
  const lines = [`  week back ${dayAndClock(weekBackAt)}, in ${away < 3 * DAY ? `${Math.round(away / HOUR)} h` : `${Math.round(away / DAY)} d`}`];
  const dates = resetEnds.map(end => new Date(end)).map(end =>
    `${end.getDate()} ${MONTHS[end.getMonth()]}${end.getFullYear() === new Date(now).getFullYear() ? "" : ` ${end.getFullYear()}`}`);
  let line = "  free resets end";
  dates.forEach((date, index) => {
    const piece = ` ${date}${index < dates.length - 1 ? "," : ""}`;
    if ([...line, ...piece].length > PHONE_WIDTH) { lines.push(line); line = `   ${piece}`; } else line += piece;
  });
  return dates.length ? [...lines, line] : lines;
}

/** WHAT: Chooses the one action for the account in use that is stopped now, else the one working nearest a limit it reaches. WHY: Mattias wants a clean recommendation last, or none. */
function actionLines(facts, { config, now, skipAccounts = new Set() }) {
  const stopped = facts.filter(fact => !skipAccounts.has(fact.account) && fact.account.inUse?.length && (fact.blockedBy5h || fact.week?.usedPercent >= 100));
  const nearing = facts.filter(fact => !skipAccounts.has(fact.account) && working(fact.account).length && fact.week?.usedPercent >= config.warnPercent
    && fact.week.usedPercent < 100 && fact.runsOut).sort((a, b) => b.week.usedPercent - a.week.usedPercent);
  const fact = [...stopped, ...nearing][0];
  if (!fact) return [];
  const spare = spareFor(fact, facts, config);
  if (spare) return [`→ Use ${spare.name}: ${fact.engine.switchCommand(spare.account)}`];
  const spent = fact.week?.usedPercent >= 100;
  if (!spent && fact.blockedBy5h) return [`→ ${fact.name} back at ${untilClock(fact.blockedBy5h.resetsAt, now)}`];
  // A manually read reset is only actionable while its evidence is fresh.
  const subscription = fact.account.subscription || {};
  const reset = manualSubscriptionFacts(subscription, now).find(item => item.field === "freeResetsLeft");
  const resetEnds = weeklyResetEnds(subscription, now);
  const weeklyLeft = Array.isArray(subscription.limitResets) ? resetEnds.length : subscription.freeResetsLeft;
  if (!reset || reset.stale || !(weeklyLeft > 0)) return [`→ ${fact.name} back ${dayAndClock(fact.week.resetsAt)}`];
  const weekBackAt = Date.parse(fact.week.resetsAt), when = spent ? "now" : "at 0% left";
  return [...resetFactLines(weekBackAt, resetEnds, now),
    worthPressing(weekBackAt, resetEnds, now) ? `→ Free reset ${fact.name} ${when}` : `→ Wait for ${fact.name}${spent ? "" : ` ${when}`}`];
}

/** WHAT: Calculates Fable reset value and its race against the week for measured Ultra plans.
 * WHY: Keeps an unmeasured plan or a reset between readings from becoming a false forecast. */
function fableAdvice(fact, { now, readingsOf, floorPercent, warnPercent = 80 }) {
  const { account, week, name } = fact, fable = fableQuotaOf(account);
  const reset = account.subscription?.limitResets?.some(item => item.kind === "fable" && Date.parse(item.expires) > now);
  // Near its end the Fable window stands in the box before it stops a pane: what is left, when it returns, and whether a free reset
  // waits (18 Nov 2026: A's Fable ended with 49 % of its week left and nothing had said so).
  const near = Number.isFinite(fable?.usedPercent) && fable.usedPercent >= warnPercent && account.activeInUse?.length
    ? [`${name}: Fable ${Math.max(0, Math.round(100 - fable.usedPercent))}% left, back ${dayAndClock(fable.resetsAt)}${reset ? ", free Fable reset ready" : ""}`] : [];
  if (!reset || !week || !Number.isFinite(fable?.usedPercent)) return near;
  return [...near, ...fableResetAdvice(fact, fable, { now, readingsOf, floorPercent })];
}
function fableResetAdvice(fact, fable, { now, readingsOf, floorPercent }) {
  const { account, week, name } = fact;
  const fullPoints = fableFullWeekPoints(account.subscription), ultra = fullPoints !== null;
  const value = Number((fable.usedPercent * (fullPoints ?? 0) / 100).toFixed(1)).toString().replace(".", ",");
  const lines = ultra ? [`${name}: Fable reset gives ${value} week ${value === "1" ? "point" : "points"}`] : [];
  if (fable.usedPercent >= 100 || (floorPercent > 0 && 100 - week.usedPercent <= floorPercent)) {
    if (account.activeInUse?.length && Date.parse(week.resetsAt) - now > WAIT_WITHIN_MS)
      lines.push(`${name}: press Fable reset now`);
    return lines;
  }
  if (!ultra) return lines;
  const at = Date.parse(account.observation?.observedAt);
  const same = (a, b) => Number.isFinite(Date.parse(a)) && Math.abs(Date.parse(a) - Date.parse(b)) < 30 * 60_000;
  const previous = readingsOf(account).filter(p => Number.isFinite(p.at) && at - p.at >= HOUR && now - p.at <= 24 * HOUR
    && Number.isFinite(p.fableUsedPercent) && Number.isFinite(p.usedPercent)
    && p.usedPercent <= week.usedPercent && p.fableUsedPercent <= fable.usedPercent
    && same(p.resetsAt, week.resetsAt) && same(p.fableResetsAt, fable.resetsAt)).sort((a, b) => a.at - b.at)[0];
  if (previous) {
    const weekRise = week.usedPercent - previous.usedPercent, fableRise = fable.usedPercent - previous.fableUsedPercent;
    if (weekRise > 0 && (fableRise === 0 || (100 - week.usedPercent) * fableRise < weekRise * (100 - fable.usedPercent)))
      lines.push(`${name}: week ends before Fable`);
  }
  return lines;
}

/**
 * WHAT: Formats the quota box: every account's week as a monospace table, then one action or none.
 * WHY: Keeps what is left, when it resets and what to do in one view a phone can read.
 */
export function buildQuotaOverview(snapshot, { config, now = Date.now(), readingsOf = () => [], floorPercent = quotaFloorPercent() }) {
  const accounts = (snapshot?.accounts || []).filter(account => !isIdleLoggedOut(account));
  const shown = ENGINES.flatMap(engine => accounts.filter(account => account.provider === engine.provider)
    .sort((a, b) => (b.inUse?.length || 0) - (a.inUse?.length || 0)));
  const facts = shown.map(account => accountFact(ENGINES.find(engine => engine.provider === account.provider), account, shown, { now, readingsOf }));
  const width = Math.max(0, ...facts.map(fact => fact.name.length));
  // The percent is what is left, as Mattias asked; the detail lines of amux quota give what is used.
  const table = [`${" ".repeat(width)} panes  left  reset`, ...facts.flatMap(fact => linesOf(fact, width, now))];
  const fable = facts.map(fact => ({ fact, lines: fableAdvice(fact, { now, readingsOf, floorPercent, warnPercent: config.warnPercent }) }));
  const skipAccounts = new Set(fable.filter(item => item.lines.some(line => line.endsWith("press Fable reset now"))).map(item => item.fact.account));
  return { text: ["```", ...table, "```", ...fable.flatMap(item => item.lines), ...actionLines(facts, { config, now, skipAccounts })].join("\n") };
}
