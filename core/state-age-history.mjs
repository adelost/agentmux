import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { planStateAge } from "./state-age-guard.mjs";
import { stateAgeClockHistory } from "./state-age-state-history.mjs";
import { stateAgeDigests } from "./state-age-digests.mjs";
export { stateAgeRows } from "./state-age-rows.mjs";

const git = (root, args) => execFileSync("git", ["-C", root, ...args], {
  encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
}).trimEnd();
const digest = value => createHash("sha256").update(value).digest("hex");
const currentCache = new Map();

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

/** WHAT: Reads a remote-default snapshot with state-word clocks. WHY: Prevents current notes and owner annotations from resetting historical state age. */
export async function readStateAgeSnapshot(project, tip, at = null) {
  const sha = at === null ? tip : git(project.root, ["rev-list", "--first-parent", "-1", `--before=${new Date(at).toISOString()}`, tip]);
  if (!sha) return { ...project, tip, sha: null, rows: [] };
  const cacheKey = `${project.root}:${project.ledger}`;
  let cached = currentCache.get(cacheKey);
  if (!cached || cached.sha !== sha) {
    const ledgerSha = git(project.root, ["log", "--first-parent", "-1", "--format=%H", sha, "--", project.ledger]);
    if (!ledgerSha) throw Error(`No historical ledger ${project.ledger} in ${project.id}`);
    const history = await stateAgeClockHistory(project, sha, new Set([ledgerSha]));
    cached = { sha, rows: history.snapshots.get(ledgerSha) || [] }; currentCache.set(cacheKey, cached);
  }
  return { ...project, tip, sha, rows: cached.rows };
}

/** WHAT: Builds an exact hourly replay with the same daily recipient digests as live checks. WHY: Keeps unsent later alerts from masquerading as rows mentioned in an earlier digest. */
export async function replayStateAge(project, { since, until, panesAt = null }) {
  if (!Number.isFinite(since) || !Number.isFinite(until) || until < since || until > Date.now()) throw Error("Invalid historical state-age window");
  const source = stateAgeDefault(project), ticks = [], wanted = new Set();
  for (let at = since; at <= until; at += 3600000) {
    const sha = git(project.root, ["rev-list", "--first-parent", "-1", `--before=${new Date(at).toISOString()}`, source.tip]);
    const ledgerSha = sha && git(project.root, ["log", "--first-parent", "-1", "--format=%H", sha, "--", project.ledger]);
    ticks.push({ at, sha, ledgerSha }); if (ledgerSha) wanted.add(ledgerSha);
  }
  const history = await stateAgeClockHistory(project, source.tip, wanted);
  const seen = new Set(), flagged = new Set(), days = {}, firstFlags = {}, firstNamed = {}, snapshots = [];
  for (const { at, sha, ledgerSha } of ticks) {
    const snapshot = { ...project, sha, rows: history.snapshots.get(ledgerSha) || [] };
    const plan = planStateAge({ projects: [snapshot], panes: panesAt?.(at) || [], now: at });
    const messages = stateAgeDigests(plan, [snapshot], seen);
    const day = days[plan.day] ||= { rows: 0, paneAlarms: 0, messages: 0, recipients: {}, alarms: [], deliveries: [], ambiguousRows: [] };
    day.ambiguousRows.push(...plan.unknownClocks.filter(item => item.kind === "duplicate-row").map(item => ({ ...item, sha })));
    snapshots.push({ at: new Date(at).toISOString(), sha, ledgerSha, rows: snapshot.rows.length });
    for (const alarm of plan.alarms) {
      if (flagged.has(alarm.key)) continue;
      flagged.add(alarm.key); day.alarms.push({ ...alarm, at: new Date(at).toISOString(), sha });
      if (alarm.kind === "row") { day.rows++; firstFlags[alarm.row] ||= new Date(at).toISOString(); } else day.paneAlarms++;
    }
    for (const message of messages) {
      for (const key of message.receiptKeys || [message.idempotencyKey]) seen.add(key);
      day.deliveries.push({ ...message, at: new Date(at).toISOString() });
      day.recipients[message.target] = (day.recipients[message.target] || 0) + 1;
      for (const item of message.mentioned) firstNamed[item.row] ||= new Date(at).toISOString();
    }
    day.messages += messages.length;
  }
  const sample = Object.values(days).flatMap(day => day.alarms).filter(a => a.kind === "row" && a.reasons.includes("state-age"))
    .sort((a, b) => digest(a.key).localeCompare(digest(b.key))).slice(0, 10).map(a => ({ key: a.key, row: a.row, project: a.project,
      at: a.at, sha: a.sha, stateWord: a.stateWord, stateChangedAt: a.stateChangedAt, changedAt: a.changedAt,
      stateSourceSha: a.stateSourceSha, ownerSourceSha: a.ownerSourceSha, ageMs: a.ageMs, limitMs: a.limitMs }));
  return { project: project.id, since: new Date(since).toISOString(), until: new Date(until).toISOString(), source,
    paneHistoryAvailable: Boolean(panesAt), days, firstFlags, firstNamed, snapshots, sample, sampleHash: digest(JSON.stringify(sample)),
    sampleReview: { reviewed: 0, falseRecentChanges: null, complete: false }, eligible: false };
}
