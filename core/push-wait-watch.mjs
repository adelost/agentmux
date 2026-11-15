import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MINUTE = 60_000;
const WINDOW = 120 * MINUTE;

/** WHAT: Returns the landed code commit verdict. WHY: Keeps the window on committer time; squashing into a new commit blinds the author-time measure. */
export function pushWaitVerdict(commits, nowMs) {
  const landed = commits.filter(c => c.committerMs > nowMs - WINDOW && c.committerMs <= nowMs
    && c.files.some(f => !f.endsWith(".md") && !f.startsWith("docs/")));
  const late = landed.filter(c => c.committerMs - c.authorMs > 30 * MINUTE)
    .map(c => ({ sha: c.sha, subject: c.subject, minutes: Math.floor((c.committerMs - c.authorMs) / MINUTE) }));
  return { on: late.length >= 3 && late.length / landed.length >= 0.25, landed: landed.length, late,
    longest: Math.max(0, ...late.map(c => c.minutes)) };
}

/** WHAT: Reads Git's name-only records. WHY: Separates code commits from ledger and prose changes. */
export function parsePushWaitLog(log) {
  const commits = []; let current;
  for (const line of log.split("\n")) {
    const header = /^@([a-f0-9]{40}) (\d+) (\d+) (.*)$/u.exec(line);
    if (header) {
      current = { sha: header[1], authorMs: Number(header[2]) * 1000,
        committerMs: Number(header[3]) * 1000, subject: header[4], files: [] };
      commits.push(current);
    } else if (line.trim() && current) current.files.push(line.trim());
  }
  return commits;
}

/** WHAT: Reads one fetched master window in a private mirror. WHY: Prevents the watch from locking the shared checkout's remote refs. */
export function readPushWaitCommits(repo, nowMs) {
  const base = join(homedir(), ".agentmux", "push-wait");
  const mirror = join(base, `${createHash("sha256").update(repo).digest("hex").slice(0, 16)}.git`);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  if (!existsSync(mirror)) {
    const remote = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 15_000 }).trim();
    execFileSync("git", ["clone", "--bare", "--filter=blob:none", "--single-branch", "--branch", "master", remote, mirror], { timeout: 120_000 });
  }
  execFileSync("git", ["-C", mirror, "fetch", "-q", "origin", "master:refs/heads/master"], { timeout: 60_000 });
  const output = execFileSync("git", ["-C", mirror, "log", "refs/heads/master", `--since=${new Date(nowMs - WINDOW).toISOString()}`,
    "--format=@%H %at %ct %s", "--name-only"], { encoding: "utf8", timeout: 60_000, maxBuffer: 20_000_000 });
  return parsePushWaitLog(output);
}

/** WHAT: Returns the count of unlanded recent code on local branches. WHY: Keeps the full-stop measurement separate from alerts. */
export function readPushWaitUnlanded(repo, nowMs) {
  const options = { encoding: "utf8", timeout: 60_000, maxBuffer: 20_000_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" } };
  const refs = execFileSync("git", ["-C", repo, "for-each-ref", "--format=%(refname)", "refs/heads/"], options).trim().split("\n").filter(Boolean);
  if (!refs.length) return 0;
  const log = execFileSync("git", ["-C", repo, "log", ...refs, "--not", "origin/master", `--since=${new Date(nowMs - 24 * 60 * MINUTE).toISOString()}`,
    "--format=@%H %at %ct %s", "--name-only"], options);
  return parsePushWaitLog(log).filter(c => c.authorMs > nowMs - 24 * 60 * MINUTE && c.authorMs <= nowMs - 30 * MINUTE
    && c.files.some(f => !f.endsWith(".md") && !f.startsWith("docs/"))).length;
}

/** WHAT: Checks independent repository episodes. WHY: Prevents a transient off sample from causing duplicate notices. */
export async function pollPushWaitOnce({ repos, readCommits, readUnlanded = async () => 0, readState, writeState, send, notify, tell = "sandman:0", now = Date.now, log = console.error }) {
  let state = readState() || {};
  const results = {};
  for (const repo of repos) {
    let commits, unlanded;
    const at = now();
    try { commits = await readCommits(repo, at); unlanded = await readUnlanded(repo, at); }
    catch (error) { log(`push wait ${repo}: ${error.message}`); continue; }
    const verdict = pushWaitVerdict(commits, at);
    let episode = state[repo]?.episode || null;
    const history = [...(state[repo]?.history || [])];
    const day = new Date(at).toISOString().slice(0, 10);
    const humanAlerts = state[repo]?.humanAlerts?.day === day ? { ...state[repo].humanAlerts } : { day, count: 0 };
    if (verdict.on) {
      if (!episode) episode = { id: randomUUID(), startedAt: at, openedVerdict: verdict, paneAt: null, notified: false, offSince: null };
      episode.offSince = null;
    } else if (episode) {
      episode.offSince ??= at;
      if (at - episode.offSince >= 30 * MINUTE) { history.push({ ...episode, endedAt: episode.offSince }); episode = null; }
    }
    state = { ...state, [repo]: { observedAt: at, verdict, episode, history, humanAlerts, unlanded } };
    writeState(state);
    if (verdict.on && (episode.paneAt === null || at - episode.paneAt >= 60 * MINUTE)) {
      const items = verdict.late.map(c => `${c.sha.slice(0, 12)} ${c.subject} (${c.minutes} min)`).join("\n");
      const text = `[push wait] ${repo}: ${verdict.late.length} av ${verdict.landed} kodcommits väntade över 30 min.\n${items}\n`
        + "Ingen panel får sätta villkor på en push (docs/fleet/merge-release.md, Push without waiting). Hitta och ta bort hindret; berätta för Mattias på en rad vad som höll och sedan när.";
      const result = await send(text, { idempotencyKey: `push-wait:${episode.id}:${Math.floor((at - episode.startedAt) / (60 * MINUTE))}` });
      if (result?.sent || result?.deduped || result?.id) { episode.paneAt = at; writeState(state); }
    }
    if (verdict.on && episode.paneAt !== null && !episode.notified) {
      if (humanAlerts.count >= 3) { episode.notified = true; episode.humanSuppressed = true; writeState(state); results[repo] = verdict; continue; }
      const result = await notify(`Push wait ${repo}: ${verdict.late.length} av ${verdict.landed} kodcommits väntade över 30 min, längst ${verdict.longest} min. Meddelande köat till ${tell}.`,
        { idempotencyKey: `push-wait-human:${episode.id}`, level: "warning", title: "Push wait" });
      if (result?.sent || result?.deduped) { episode.notified = true; humanAlerts.count++; writeState(state); }
    }
    results[repo] = verdict;
  }
  return results;
}
