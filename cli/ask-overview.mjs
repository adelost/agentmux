// WHAT: Renders a bounded, per-agent overview from durable ask rows.
// WHY: Lets humans and agents orient by project and recent pane without reading the flat ledger.

import { formatAskStatus } from "./ask-format.mjs";

const DEFAULT_PER_AGENT = 3;

/** WHAT: Formats one bounded ask preview without transport chrome while retaining its ending. WHY: Keeps voice wrappers and attachment paths from consuming the useful preview. */
export function compactAskOverviewText(value, maxChars = 112) {
  let text = String(value || "").replace(/\r\n?/gu, "\n").trim();
  text = text.replace(/^(?:\[from\s+[^:\]]+:\d+\]\s*)+/iu, "");
  text = text.replace(/^\[transcribed voice[^\]]*\]\s*/iu, "");

  let images = 0;
  let files = 0;
  text = text.replace(/\[(image|file) attached:\s*[^\]]+\]/giu, (_match, kind) => {
    if (String(kind).toLowerCase() === "image") images++;
    else files++;
    return " ";
  });
  text = text.replace(/={3,}/gu, " ").replace(/\s+/gu, " ").trim();

  const attachments = [
    images ? `${images === 1 ? "bild" : `${images} bilder`}` : null,
    files ? `${files === 1 ? "fil" : `${files} filer`}` : null,
  ].filter(Boolean);
  const suffix = attachments.length ? ` [${attachments.join(", ")}]` : "";
  if (!text) return suffix.trim();
  if (text.length + suffix.length <= maxChars) return `${text}${suffix}`;

  const room = Math.max(20, maxChars - suffix.length - 3);
  const headLength = Math.ceil(room * 0.68);
  const tailLength = Math.max(8, room - headLength);
  return `${text.slice(0, headLength).trimEnd()} … ${text.slice(-tailLength).trimStart()}${suffix}`;
}

/** WHAT: Builds agent groups with the newest selected ask for each pane. WHY: Keeps recent pane breadth visible without hiding aggregate backlog. */
export function buildAskOverview(entries = [], { perAgent = DEFAULT_PER_AGENT } = {}) {
  const groups = new Map();
  const boundedPerAgent = Number.isFinite(perAgent) && perAgent > 0
    ? Math.floor(perAgent)
    : DEFAULT_PER_AGENT;

  for (const entry of entries) {
    const agent = entry.agent || "unknown";
    const group = groups.get(agent) || {
      agent,
      total: 0,
      open: 0,
      needsYou: 0,
      unverified: 0,
      latestTsMs: 0,
      latestByPane: new Map(),
      entries: [],
    };
    group.total++;
    if (entry.open) group.open++;
    if (entry.status === "needs-you") group.needsYou++;
    if (entry.status === "unverified") group.unverified++;
    group.entries.push(entry);
    if (Number.isFinite(entry.tsMs)) group.latestTsMs = Math.max(group.latestTsMs, entry.tsMs);
    const paneKey = `${agent}:${entry.pane}`;
    const previous = group.latestByPane.get(paneKey);
    if (!previous || (entry.tsMs || 0) > (previous.tsMs || 0)) group.latestByPane.set(paneKey, entry);
    groups.set(agent, group);
  }

  return [...groups.values()].map((group) => {
    const panes = [...group.latestByPane.values()]
      .sort((left, right) => (right.tsMs || 0) - (left.tsMs || 0));
    const recentAsks = panes.slice(0, boundedPerAgent);
    if (recentAsks.length < boundedPerAgent) {
      const selected = new Set(recentAsks);
      const extras = [...group.entries]
        .sort((left, right) => (right.tsMs || 0) - (left.tsMs || 0))
        .filter((entry) => !selected.has(entry));
      recentAsks.push(...extras.slice(0, boundedPerAgent - recentAsks.length));
    }
    const representedPanes = new Set(recentAsks.map((entry) => `${entry.agent}:${entry.pane}`));
    return {
      agent: group.agent,
      total: group.total,
      open: group.open,
      needsYou: group.needsYou,
      unverified: group.unverified,
      latestTsMs: group.latestTsMs,
      paneCount: panes.length,
      recentAsks,
      hiddenPanes: Math.max(0, panes.length - representedPanes.size),
      hiddenAsks: Math.max(0, group.total - recentAsks.length),
    };
  }).sort((left, right) =>
    right.latestTsMs - left.latestTsMs || left.agent.localeCompare(right.agent));
}

/** WHAT: Formats one grouped orientation view. WHY: Keeps concise orientation separate from the exact `--list` ledger drill-down. */
export function formatAskOverview(entries = [], options = {}) {
  const groups = buildAskOverview(entries, options);
  if (!groups.length) return "(no asks match)";
  const lines = ["", "Agentöversikt · senaste frågor och nyligen använda paneler"];

  for (const group of groups) {
    const stats = [`${group.open} unresolved`, `${group.total} asks`, `${group.paneCount} paneler`];
    if (group.needsYou) stats.splice(1, 0, `${group.needsYou} needs-you`);
    if (group.unverified) stats.splice(-1, 0, `${group.unverified} unverified`);
    lines.push("", `${group.agent}: ${stats.join(" · ")}`);
    for (const entry of group.recentAsks) {
      lines.push(`  ${formatAskStatus(entry.status).padEnd(13)} ${entry.key.padEnd(12)} ${formatOverviewAge(entry.ageMs)}`);
      lines.push(`     ← ${compactAskOverviewText(entry.prompt)}`);
      const reply = compactAskOverviewText(entry.reply || entry.replyPreview, 100);
      if (reply) lines.push(`     → ${reply}`);
    }
    if (group.hiddenPanes || group.hiddenAsks) {
      const hidden = [];
      if (group.hiddenPanes) hidden.push(`${group.hiddenPanes} fler paneler`);
      if (group.hiddenAsks) hidden.push(`${group.hiddenAsks} äldre asks`);
      lines.push(`  … ${hidden.join(" · ")} i fönstret`);
    }
    lines.push(`  detalj: amux asks ${group.agent} --list`);
  }
  return lines.join("\n");
}

function formatOverviewAge(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "?";
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
