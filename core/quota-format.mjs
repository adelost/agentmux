// WHAT: one text render of the shared account quota (Claude + Codex) for
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
    return `${percentCell(codexWindowLabel(window), window.usedPercent)}${reset ? ` (${reset})` : ""}`;
  }));
  return `Codex   ${cells.join(" · ")}`;
};

// Plain text that reads the same in a terminal and in Discord markdown.
export const formatQuotaSnapshot = (snapshot) => [
  "Kvot (använt, delad per konto):",
  claudeLine(snapshot?.claude),
  codexLine(snapshot?.codex),
].join("\n");
