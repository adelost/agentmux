// WHAT: one text render of the shared account quota for
//       every non-browser surface — the Discord bridge and the amux CLI.
// WHY:  the quota is account-level and already collected by quota-usage.mjs;
//       each surface re-inventing its own render is how the headline bug
//       (label-text matching) happened in the web UI. One formatter, many
//       consumers.
// DOES NOT: fetch anything, cache anything, or decide refresh policy —
//       callers own how fresh their snapshot is.

import { accountName as displayName } from "./account-names.mjs";

// Mattias 2026-10-17 12:03Z: "Undvik emoji...", so a high row says it in words.
const WARN_PERCENT = 70;
const CRITICAL_PERCENT = 90;

const severityMark = (usedPercent) => {
  if (typeof usedPercent !== "number") return "";
  if (usedPercent >= CRITICAL_PERCENT) return " (critical)";
  if (usedPercent >= WARN_PERCENT) return " (high)";
  return "";
};

const ENGLISH_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** WHAT: Returns a time rounded to the nearest minute. WHY: Keeps a reset that jitters by seconds from reading 08:59 one time and 09:00 the next. */
export const nearestMinute = (time) => new Date(Math.round(new Date(time).getTime() / 60_000) * 60_000);

/** WHAT: Formats a reset as "reset Oct 22 08:13". WHY: Keeps the quota detail lines from showing Swedish dates. */
export const formatReset = (resetsAt) => {
  if (!resetsAt) return "";
  const at = nearestMinute(resetsAt);
  if (Number.isNaN(at.getTime())) return "";
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `reset ${ENGLISH_MONTHS[at.getMonth()]} ${at.getDate()} ${hh}:${mm}`;
};

/** WHAT: Formats a local time as "08:13". WHY: Lets a same-day forecast drop its date. */
export const clockOf = (time) => `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;

/** WHAT: Formats a local time as "Oct 22 08:13". WHY: Keeps English quota notices (Mattias 2026-10-17) from showing Swedish dates. */
export const formatNoticeTime = (at) => {
  const time = new Date(at);
  if (at == null || Number.isNaN(time.getTime())) return "";
  return `${ENGLISH_MONTHS[time.getMonth()]} ${time.getDate()} ${clockOf(time)}`;
};

/**
 * WHAT: Builds the Discord and push notice for a pane stopped by its plan limit.
 * WHY: Keeps a quota stop from looking like work (lsrc:1 stood still from 02:48 to 06:50 on 2026-09-28 without a word).
 */
export const formatLimitedAlert = ({ paneKey, resetAt = null, autoResume = false, logCommand }) => {
  const reset = formatReset(resetAt);
  const next = autoResume
    ? "amux continues it in the same session when the window is back."
    : "Nudge it when the quota is back.";
  return {
    discord: `**${paneKey} has stopped, its quota is used up${reset ? ` (${reset})` : ""}.** ${next} The pane: \`${logCommand}\``,
    push: `${paneKey} has stopped on quota${reset ? `, ${reset}` : ""}. ${autoResume ? "amux continues it by itself." : "Nudge it."}`,
  };
};

const percentCell = (label, usedPercent) =>
  `${label} ${usedPercent}%${severityMark(usedPercent)}`;

const claudeLimitLabel = (limit) => {
  if (limit.kind === "session") return "session";
  if (limit.kind === "weekly_all") return "week";
  if (limit.kind === "weekly_scoped") return `week ${limit.scopeName ?? "scoped"}`;
  return limit.kind;
};

// The weekly rows share one reset instant; the session resets on its own
// clock, so it carries its own suffix instead of the shared one.
const claudeLine = (claude) => {
  if (!claude?.ok) return `Claude  unavailable (${claude?.error ?? "unknown error"})`;
  const session = claude.limits.filter((limit) => limit.kind === "session");
  const weekly = claude.limits.filter((limit) => limit.kind !== "session");
  const cells = [
    ...session.map((limit) => {
      const reset = formatReset(limit.resetsAt);
      return `${percentCell("session", limit.usedPercent)}${reset ? ` (${reset})` : ""}`;
    }),
    ...weekly.map((limit) => percentCell(claudeLimitLabel(limit), limit.usedPercent)),
  ];
  const weeklyReset = formatReset(weekly.find((limit) => limit.resetsAt)?.resetsAt);
  return `Claude  ${cells.join(" · ")}${weeklyReset ? ` (${weeklyReset})` : ""}`;
};

const codexWindowLabel = (window) =>
  window.windowMinutes === 10_080 ? "week" : `${Math.round(window.windowMinutes / 60)}h`;

const codexLine = (codex) => {
  if (!codex?.ok) return `Codex   unavailable (${codex?.error ?? "unknown error"})`;
  const cells = codex.limits.flatMap((limit) => limit.windows.map((window) => {
    const reset = formatReset(window.resetsAt);
    const label = [limit.limitName, codexWindowLabel(window)].filter(Boolean).join(" ");
    return `${percentCell(label, window.usedPercent)}${reset ? ` (${reset})` : ""}`;
  }));
  return `Codex   ${cells.join(" · ")}`;
};

const kimiLine = (kimi) => {
  if (!kimi?.ok) return `Kimi    unavailable (${kimi?.error ?? "unknown error"})`;
  if (!kimi.limits.length) return "Kimi    unavailable (no quota limits)";
  // Every window, like the Codex line: "· 2 gränser" hid exactly the fact that
  // decides what a stop means — 5h-fönstret läker självt, veckan gör det inte
  // (2026-08-05: tre paneler dömdes som månadsdöda när 5h-fönstret var boven).
  const cells = kimi.limits.map((limit) => {
    const reset = formatReset(limit.resetsAt);
    return `${percentCell(limit.scopeName || limit.id, limit.usedPercent)}${reset ? ` (${reset})` : ""}`;
  });
  return `Kimi    ${cells.join(" · ")}`;
};

// A Claude account read once for all its logins names the launch slots that use it. A login dir is one too
// (amux accounts rotate claude:<login>), unless a numbered slot shadows its name.
const launchSlotIds = (account) => (Array.isArray(account?.sharedBy)
  ? account.sharedBy.filter((member) => member.source !== "login" || !/^\d+$/u.test(member.id)).map((member) => member.id)
  : null);

// The renewal date and free resets come from the login's entry in account-profiles.json, read by hand.
const subscriptionText = ({ renewsOn, freeResetsLeft, freeResetsReadOn } = {}) => [
  ...(renewsOn ? [`renews ${renewsOn}`] : []),
  ...(Number.isInteger(freeResetsLeft) ? [`free resets ${freeResetsLeft} (read ${freeResetsReadOn})`] : []),
];

// The slots a pane can start on, which //switch N and amux accounts name.
const slotText = (account) => {
  const slots = launchSlotIds(account) ?? [account.profile.id];
  return slots.length ? `slot ${slots.join("+")}` : "no slot";
};

const accountSuffix = (account, duplicate) => {
  const identity = account?.account?.email || account?.profile?.label;
  const plan = account?.account?.plan;
  // Without its login the name already is the slot.
  const values = [account?.account?.email ? slotText(account) : null, identity, plan,
    ...subscriptionText(account?.subscription)].filter(Boolean);
  if (duplicate) values.push("same login");
  return values.length ? ` · ${values.join(" · ")}` : "";
};

const accountLine = (account, peers, duplicates = new Set()) => {
  const rendered = account?.provider === "claude" ? claudeLine(account)
    : account?.provider === "kimi" ? kimiLine(account)
      : codexLine(account);
  if (!account?.profile?.id) return rendered;
  return `${displayName(account, peers)}${accountSuffix(account, duplicates.has(account.profile?.key))}  `
    + rendered.replace(/^\S+\s+/u, "");
};

// A login nobody can use and no pane runs on is noise next to the accounts that matter.
const LOGGED_OUT = new Set(["login_expired", "credentials_expired", "credentials_unavailable", "login_required"]);
const isIdleLoggedOut = (account) => !account?.ok && LOGGED_OUT.has(account?.error)
  && Array.isArray(account.inUse) && account.inUse.length === 0;


const runsOf = (panes) => panes.reduce((runs, pane) => {
  const last = runs.at(-1);
  if (last && pane === last.at(-1) + 1) last.push(pane);
  else runs.push([pane]);
  return runs;
}, []);

const runText = (run) => run.length > 2 ? `${run[0]}–${run.at(-1)}` : run.join(",");

/** WHAT: Formats pane keys as one range per project ("api:0–2, claw:0"). WHY: Keeps the in-use line readable at a glance. */
export const compactPaneList = (keys) => {
  const byProject = new Map();
  for (const key of keys) {
    const split = key.lastIndexOf(":");
    const project = key.slice(0, split);
    byProject.set(project, [...(byProject.get(project) || []), Number(key.slice(split + 1))]);
  }
  return [...byProject].sort(([left], [right]) => left.localeCompare(right))
    .map(([project, panes]) => `${project}:${runsOf([...new Set(panes)].sort((a, b) => a - b)).map(runText).join(",")}`)
    .join(", ");
};

const inUseLine = (account) => (account.inUse.length
  ? `  in use: ${compactPaneList(account.inUse)}` : "  no pane");

const accountLines = (account, peers, duplicates) => (Array.isArray(account?.inUse)
  ? [accountLine(account, peers, duplicates), inUseLine(account)] : [accountLine(account, peers, duplicates)]);

// A logged-out login is named among every login, so one sharing an initial with a live one keeps its whole name.
const trailingLines = (snapshot, collapsed) => [
  ...(collapsed.length ? [`Logged out: ${collapsed.map((account) => displayName(account, snapshot.accounts)).join(" · ")}`] : []),
  ...(snapshot.accountFileProblems?.length ? [`account-profiles.json: ${snapshot.accountFileProblems.join("; ")}`] : []),
  ...(snapshot.panesOnUnknownLogin?.length
    ? [`Panes on a login amux does not know: ${snapshot.panesOnUnknownLogin
      .map((pane) => `${pane.key} (${pane.home})`).join(", ")}`] : []),
];

const snapshotLines = (snapshot) => {
  if (Array.isArray(snapshot?.accounts) && snapshot.accounts.length) {
    const order = ["codex", "claude", "kimi"];
    const identities = new Map();
    for (const account of snapshot.accounts) {
      const identity = account?.account?.email?.toLowerCase()
        || account?.account?.identityKey;
      if (!identity) continue;
      const key = `${account.provider}:${identity}`;
      identities.set(key, [...(identities.get(key) || []), account.profile?.key]);
    }
    const duplicates = new Set([...identities.values()]
      .filter((keys) => keys.length > 1).flat());
    const ordered = order.flatMap((provider) => snapshot.accounts.filter((account) => account.provider === provider));
    const shown = ordered.filter((account) => !isIdleLoggedOut(account));
    return [
      ...shown.flatMap((account) => accountLines(account, shown, duplicates)),
      ...trailingLines(snapshot, ordered.filter(isIdleLoggedOut)),
    ];
  }
  return [claudeLine(snapshot?.claude), codexLine(snapshot?.codex)];
};

/** WHAT: Builds one shared account view. WHY: Keeps terminal and Discord quota truth identical. */
export const formatQuotaSnapshot = (snapshot) => [
  "Quota (used, shared per account):",
  ...snapshotLines(snapshot),
].join("\n");
