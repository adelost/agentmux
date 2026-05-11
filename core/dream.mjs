import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { readAllTurnsAcrossPanes, parseSinceArg } from "./jsonl-reader.mjs";
import { collectCommitsSince, reposFromAgents } from "./commit-log.mjs";

const DEFAULT_TZ = "Europe/Stockholm";
const DEFAULT_SINCE = "24h";
const DEFAULT_MIN_TURNS = 10;
const MAX_PANES = 12;
const MAX_COMMITS = 15;

function localDate(date, timeZone = DEFAULT_TZ) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function localDateTime(date, timeZone = DEFAULT_TZ) {
  const day = localDate(date, timeZone);
  const time = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${day} ${time}`;
}

function truncateText(text, max = 170) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 3) + "...";
}

function rowMs(row) {
  const ms = Date.parse(row?.timestamp || "");
  return Number.isNaN(ms) ? 0 : ms;
}

function formatUtcMinute(ms) {
  if (!ms) return "--:--";
  return new Date(ms).toISOString().slice(11, 16);
}

function groupRowsByPane(rows) {
  const panes = new Map();
  for (const row of rows) {
    const key = `${row.agent}:${row.pane}`;
    const bucket = panes.get(key) || {
      key,
      agent: row.agent,
      pane: row.pane,
      latestMs: 0,
      events: 0,
      userTurns: 0,
      toolEvents: 0,
      lastUser: "",
      lastAssistant: "",
    };
    bucket.events++;
    const ms = rowMs(row);
    if (ms > bucket.latestMs) bucket.latestMs = ms;
    if (row.role === "user") {
      bucket.userTurns++;
      bucket.lastUser = row.content;
    } else if (row.role === "assistant" && row.type === "text") {
      bucket.lastAssistant = row.content;
    } else if (row.role === "assistant" && row.type === "tool") {
      bucket.toolEvents++;
    }
    panes.set(key, bucket);
  }
  return [...panes.values()].sort((a, b) => b.latestMs - a.latestMs);
}

export function buildDreamSection({
  dateKey,
  rows,
  commits = [],
  sinceMs,
  now = new Date(),
  timeZone = DEFAULT_TZ,
  minTurns = DEFAULT_MIN_TURNS,
}) {
  const userTurns = rows.filter((row) => row.role === "user").length;
  if (userTurns < minTurns) {
    return {
      skipped: true,
      reason: `only ${userTurns} user turn${userTurns === 1 ? "" : "s"} since cutoff, threshold ${minTurns}`,
      userTurns,
    };
  }

  const panes = groupRowsByPane(rows).filter((pane) => pane.userTurns > 0);
  const lines = [];
  lines.push(`<!-- amux-dream:${dateKey} -->`);
  lines.push(`## amux dream: ${localDateTime(now, timeZone)} (${timeZone})`);
  lines.push("");
  lines.push(`Automatisk nattlig digest fran \`amux dream --since ${DEFAULT_SINCE}\`.`);
  lines.push(`Period: ${new Date(sinceMs).toISOString()} -> ${now.toISOString()}.`);
  lines.push(`User turns: ${userTurns}. Panes: ${panes.length}. Commits: ${commits.length}.`);
  lines.push("");
  lines.push("### Panes");
  if (!panes.length) {
    lines.push("- No pane activity.");
  } else {
    for (const pane of panes.slice(0, MAX_PANES)) {
      lines.push(`- \`${pane.key}\`: ${pane.userTurns} turn${pane.userTurns === 1 ? "" : "s"}, latest ${formatUtcMinute(pane.latestMs)} UTC`);
      if (pane.lastUser) lines.push(`  - user: ${truncateText(pane.lastUser)}`);
      if (pane.lastAssistant) lines.push(`  - assistant: ${truncateText(pane.lastAssistant)}`);
      if (!pane.lastAssistant && pane.toolEvents) lines.push(`  - tools: ${pane.toolEvents}`);
    }
    if (panes.length > MAX_PANES) lines.push(`- ... ${panes.length - MAX_PANES} more panes omitted.`);
  }
  lines.push("");
  lines.push("### Commits");
  if (!commits.length) {
    lines.push("- No commits.");
  } else {
    for (const commit of commits.slice(0, MAX_COMMITS)) {
      lines.push(`- \`${commit.label}\` ${commit.hash.slice(0, 7)} ${truncateText(commit.subject, 120)}`);
    }
    if (commits.length > MAX_COMMITS) lines.push(`- ... ${commits.length - MAX_COMMITS} more commits omitted.`);
  }
  lines.push(`<!-- /amux-dream:${dateKey} -->`);
  lines.push("");
  return { skipped: false, section: lines.join("\n"), userTurns, panes: panes.length };
}

export function upsertDreamSection(content, dateKey, section) {
  const start = `<!-- amux-dream:${dateKey} -->`;
  const end = `<!-- /amux-dream:${dateKey} -->`;
  const startIdx = content.indexOf(start);
  if (startIdx !== -1) {
    const endIdx = content.indexOf(end, startIdx);
    if (endIdx !== -1) {
      return content.slice(0, startIdx).trimEnd() + "\n\n" + section + content.slice(endIdx + end.length);
    }
  }
  const prefix = content.trimEnd();
  return (prefix ? prefix + "\n\n" : "") + section;
}

export function defaultDailyContent(dateKey) {
  return `<!-- template: daily -->\n> summary: Daily notes for ${dateKey}, auto-created by amux dream.\n> why: Session continuity and nightly agent activity digest.\n\n# ${dateKey}\n`;
}

export function resolveDreamWorkspace(workspaceDir) {
  return workspaceDir || process.env.OPENCLAW_WORKSPACE || join(process.env.HOME, ".openclaw", "workspace");
}

export function runDreamDigest({
  agents,
  workspaceDir,
  sinceArg = DEFAULT_SINCE,
  minTurns = DEFAULT_MIN_TURNS,
  dryRun = false,
  now = new Date(),
  timeZone = DEFAULT_TZ,
} = {}) {
  const since = parseSinceArg(sinceArg);
  if (!since) throw new Error(`invalid --since '${sinceArg}'. Use ISO or relative ("24h", "2h", "30min").`);
  const resolvedWorkspace = resolveDreamWorkspace(workspaceDir);
  const dateKey = localDate(now, timeZone);
  const outPath = join(resolvedWorkspace, "memory", `${dateKey}.md`);
  const rows = readAllTurnsAcrossPanes({ agents, since });
  const commits = collectCommitsSince(reposFromAgents(agents), since.getTime(), MAX_COMMITS);
  const built = buildDreamSection({
    dateKey,
    rows,
    commits,
    sinceMs: since.getTime(),
    now,
    timeZone,
    minTurns,
  });
  if (built.skipped) {
    return { ...built, path: outPath, written: false };
  }

  const original = existsSync(outPath) ? readFileSync(outPath, "utf-8") : defaultDailyContent(dateKey);
  const next = upsertDreamSection(original, dateKey, built.section);
  if (!dryRun) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, next.endsWith("\n") ? next : next + "\n");
  }
  return { ...built, path: outPath, written: !dryRun, content: next };
}
