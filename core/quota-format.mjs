// WHAT: one text render of the shared account quota for
//       every non-browser surface — the Discord bridge and the amux CLI.
// WHY:  the quota is account-level and already collected by quota-usage.mjs;
//       each surface re-inventing its own render is how the headline bug
//       (label-text matching) happened in the web UI. One formatter, many
//       consumers.
// DOES NOT: fetch anything, cache anything, or decide refresh policy —
//       callers own how fresh their snapshot is.

const WARN_PERCENT = 70;
const CRITICAL_PERCENT = 90;

const severityMark = (usedPercent) => {
  if (typeof usedPercent !== "number") return "";
  if (usedPercent >= CRITICAL_PERCENT) return " 🔴";
  if (usedPercent >= WARN_PERCENT) return " ⚠️";
  return "";
};

const SHORT_MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

export const formatReset = (resetsAt) => {
  if (!resetsAt) return "";
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return "";
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `reset ${at.getDate()} ${SHORT_MONTHS[at.getMonth()]} ${hh}:${mm}`;
};

const percentCell = (label, usedPercent) =>
  `${label} ${usedPercent}%${severityMark(usedPercent)}`;

const claudeLimitLabel = (limit) => {
  if (limit.kind === "session") return "session";
  if (limit.kind === "weekly_all") return "vecka";
  if (limit.kind === "weekly_scoped") return `vecka ${limit.scopeName ?? "scoped"}`;
  return limit.kind;
};

// The weekly rows share one reset instant; the session resets on its own
// clock, so it carries its own suffix instead of the shared one.
const claudeLine = (claude) => {
  if (!claude?.ok) return `Claude  otillgänglig (${claude?.error ?? "okänt fel"})`;
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
  window.windowMinutes === 10_080 ? "vecka" : `${Math.round(window.windowMinutes / 60)}h`;

const codexLine = (codex) => {
  if (!codex?.ok) return `Codex   otillgänglig (${codex?.error ?? "okänt fel"})`;
  const cells = codex.limits.flatMap((limit) => limit.windows.map((window) => {
    const reset = formatReset(window.resetsAt);
    const label = [limit.limitName, codexWindowLabel(window)].filter(Boolean).join(" ");
    return `${percentCell(label, window.usedPercent)}${reset ? ` (${reset})` : ""}`;
  }));
  return `Codex   ${cells.join(" · ")}`;
};

const kimiLine = (kimi) => {
  if (!kimi?.ok) return `Kimi    otillgänglig (${kimi?.error ?? "okänt fel"})`;
  const tightest = kimi.limits.reduce((current, limit) =>
    !current || limit.usedPercent > current.usedPercent ? limit : current, null);
  if (!tightest) return "Kimi    otillgänglig (inga kvotgränser)";
  const reset = formatReset(tightest.resetsAt);
  const count = kimi.limits.length === 1 ? "" : ` · ${kimi.limits.length} gränser`;
  return `Kimi    ${percentCell(tightest.scopeName || tightest.id, tightest.usedPercent)}`
    + `${reset ? ` (${reset})` : ""}${count}`;
};

const accountSuffix = (account, duplicate) => {
  const identity = account?.account?.email || account?.profile?.label;
  const plan = account?.account?.plan;
  const values = [identity, plan].filter(Boolean);
  if (duplicate) values.push("⚠ samma inloggning");
  return values.length ? ` · ${values.join(" · ")}` : "";
};

const accountLine = (account, duplicates = new Set()) => {
  const rendered = account?.provider === "claude" ? claudeLine(account)
    : account?.provider === "kimi" ? kimiLine(account)
      : codexLine(account);
  const id = account?.profile?.id;
  if (!id) return rendered;
  const providerName = account.provider === "claude" ? "Claude"
    : account.provider === "kimi" ? "Kimi" : "Codex";
  return `${providerName} ${id}${accountSuffix(account, duplicates.has(account.profile?.key))}  `
    + rendered.replace(/^\S+\s+/u, "");
};

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
    return order.flatMap((provider) =>
      snapshot.accounts.filter((account) => account.provider === provider)
        .map((account) => accountLine(account, duplicates)));
  }
  return [claudeLine(snapshot?.claude), codexLine(snapshot?.codex)];
};

/** WHAT: Builds one shared account view. WHY: Keeps terminal and Discord quota truth identical. */
export const formatQuotaSnapshot = (snapshot) => [
  "Kvot (använt, delad per konto):",
  ...snapshotLines(snapshot),
].join("\n");
