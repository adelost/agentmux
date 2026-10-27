import { execFileSync } from "node:child_process";
import { onTrackRows } from "./on-track-evidence.mjs";
import { planStateAge } from "./state-age-guard.mjs";

const git = (root, args) => execFileSync("git", ["-C", root, ...args], {
  encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
}).trimEnd();
const normalized = value => value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9#]/gu, "");

/** WHAT: Resolves an observed remote default tip. WHY: Prevents local working-copy bytes or branches from changing the alarm clock. */
export function stateAgeDefault(project) {
  let ref;
  try { ref = git(project.root, ["symbolic-ref", "refs/remotes/origin/HEAD"]); }
  catch {
    if (/^origin\/(?:master|main)$/u.test(project.ref || "")) ref = `refs/remotes/${project.ref}`;
    else {
      try { git(project.root, ["rev-parse", "--verify", "refs/remotes/origin/master"]); ref = "refs/remotes/origin/master"; }
      catch { ref = "refs/remotes/origin/main"; }
    }
  }
  if (!/^refs\/remotes\/origin\/(?:master|main)$/u.test(ref)) throw Error(`Unsupported default ref ${ref}`);
  return { ref, tip: git(project.root, ["rev-parse", "--verify", `${ref}^{commit}`]) };
}

/** WHAT: Reads TASKS with the shared parser and its priority column. WHY: Keeps current project tables canonical while preserving their thresholds. */
export function stateAgeRows(text) {
  const rows = [];
  let headers = [], header = "";
  for (const [lineIndex, line] of text.split("\n").entries()) {
    if (!line.startsWith("|")) continue;
    const cells = line.split(/(?<!\\)\|/u).slice(1, -1).map(s => s.trim());
    if (["#", "id", "row"].includes(normalized(cells[0] || ""))) { headers = cells.map(normalized); header = line; }
    else if (/^\d+[a-z]*$/u.test(cells[0] || "")) {
      const index = headers.findIndex(h => ["prio", "priority", "prioritet"].includes(h));
      const row = Object.values(onTrackRows(`${header}\n${line}`))[0];
      if (row) rows.push({ ...row, line: lineIndex + 1, priority: /\bP[012]\b/u.exec(cells[index] || "")?.[0] || "P1" });
    }
  }
  return rows;
}

/** WHAT: Reads a row snapshot and first-parent blame times. WHY: Prevents side-branch authoring dates from replacing default-branch arrival times. */
export function readStateAgeSnapshot(project, tip, at = null) {
  const sha = at === null ? tip : git(project.root, ["rev-list", "--first-parent", "-1", `--before=${new Date(at).toISOString()}`, tip]);
  if (!sha) return { ...project, tip, sha: null, rows: [] };
  const text = git(project.root, ["show", `${sha}:${project.ledger}`]);
  const times = new Map();
  let line = null, changedAt = null;
  for (const value of git(project.root, ["blame", "--first-parent", "--line-porcelain", sha, "--", project.ledger]).split("\n")) {
    const header = /^[a-f\d]{40} \d+ (\d+)(?: \d+)?$/u.exec(value);
    if (header) { line = Number(header[1]); changedAt = null; }
    else if (value.startsWith("committer-time ")) changedAt = Number(value.slice(15)) * 1000;
    else if (value.startsWith("\t") && line !== null) times.set(line, changedAt);
  }
  return { ...project, tip, sha, rows: stateAgeRows(text).map(row => ({ ...row, changedAt: times.get(row.line) ?? null })) };
}

/** WHAT: Builds historical row-clock observations at hourly ticks without sends. WHY: Keeps calibration separate from live messaging and makes missing pane history explicit. */
export function replayStateAge(project, { since, until, panesAt = null }) {
  if (!Number.isFinite(since) || !Number.isFinite(until) || until < since || until > Date.now()) throw Error("Invalid historical state-age window");
  const source = stateAgeDefault(project), cache = new Map(), seen = new Set(), days = {}, firstFlags = {}, snapshots = [];
  for (let at = since; at <= until; at += 3600000) {
    const sha = git(project.root, ["rev-list", "--first-parent", "-1", `--before=${new Date(at).toISOString()}`, source.tip]);
    if (!cache.has(sha)) cache.set(sha, readStateAgeSnapshot(project, sha));
    const snapshot = cache.get(sha), plan = planStateAge({ projects: [snapshot], panes: panesAt?.(at) || [], now: at, seen });
    const day = days[plan.day] ||= { rows: 0, paneAlarms: 0, messages: 0, recipients: {}, alarms: [], ambiguousRows: [] };
    day.ambiguousRows.push(...plan.unknownClocks.filter(item => item.kind === "duplicate-row").map(item => ({ ...item, sha })));
    snapshots.push({ at: new Date(at).toISOString(), sha, rows: snapshot.rows.length });
    for (const alarm of plan.alarms) {
      seen.add(alarm.key); day.alarms.push({ ...alarm, at: new Date(at).toISOString() });
      if (alarm.kind === "row") { day.rows++; firstFlags[alarm.row] ||= new Date(at).toISOString(); } else day.paneAlarms++;
    }
    day.messages += plan.messages.length;
    for (const message of plan.messages) day.recipients[message.target] = (day.recipients[message.target] || 0) + 1;
  }
  return { project: project.id, since: new Date(since).toISOString(), until: new Date(until).toISOString(), source,
    paneHistoryAvailable: Boolean(panesAt), days, firstFlags, snapshots,
    eligible: Boolean(panesAt) && Object.values(days).every(day => day.messages < 10) };
}
