// Which running panes use which subscription account, read from the engine
// process itself. A pane's selection says where it will start next; only the
// live process's config dir says which account it spends right now
// (Mattias 2026-10-10: "är det tydligt att se vilken som används för stunden").

import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { quotaAccountCatalog } from "./quota-profiles.mjs";
import { readQuotaSnapshot } from "./quota-usage.mjs";
import { DEFAULT_TMUX_SOCKET } from "./runtime-defaults.mjs";

const execFileAsync = promisify(execFile);

// The process name each engine runs under, and where it keeps its login.
const ENGINES = Object.freeze({
  claude: { env: "CLAUDE_CONFIG_DIR", directory: ".claude" },
  codex: { env: "CODEX_HOME", directory: ".codex" },
  kimi: { env: "KIMI_CODE_HOME", directory: ".kimi-code" },
});

const canonical = (path, realpath = realpathSync) => {
  try { return realpath(path); } catch { return resolve(path); }
};

/** WHAT: Parses tmux's pane list. WHY: Keeps one tmux call for every pane instead of one per pane. */
export function parsePaneList(stdout) {
  return String(stdout || "").split("\n").flatMap((line) => {
    const [session, pane, pid] = line.split("\t");
    return session && /^\d+$/u.test(pane || "") && /^\d+$/u.test(pid || "")
      ? [{ key: `${session}:${pane}`, pid: Number(pid) }] : [];
  });
}

const readProc = (readFile) => ({
  comm: (pid) => { try { return readFile(`/proc/${pid}/comm`, "utf8").trim(); } catch { return null; } },
  children: (pid) => {
    try { return readFile(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/u).filter(Boolean).map(Number); }
    catch { return []; }
  },
  environ: (pid) => {
    try { return readFile(`/proc/${pid}/environ`, "utf8").split("\0"); } catch { return []; }
  },
});

/**
 * WHAT: Resolves the engine under one pane's shell and the login dir it runs on.
 * WHY: Keeps "in use" tied to the running process, not to a selection that applies at the next start.
 */
export function engineHomeOfPane(panePid, { readFile = readFileSync, home = homedir() } = {}) {
  const proc = readProc(readFile);
  const queue = [...proc.children(panePid)];
  for (let seen = 0; queue.length && seen < 64; seen += 1) {
    const pid = queue.shift();
    const name = proc.comm(pid);
    if (name && Object.hasOwn(ENGINES, name)) {
      const engine = ENGINES[name];
      const set = proc.environ(pid).find((entry) => entry.startsWith(`${engine.env}=`));
      return { engine: name, home: set ? set.slice(engine.env.length + 1) : join(home, engine.directory) };
    }
    queue.push(...proc.children(pid));
  }
  return null;
}

/** WHAT: Reads every running engine pane and its login dir. WHY: Keeps "which account is in use" from depending on per-pane tmux calls. */
export async function readLivePaneHomes({
  socket = process.env.TMUX_SOCKET || DEFAULT_TMUX_SOCKET,
  listPanes = async () => (await execFileAsync("tmux", ["-S", socket, "list-panes", "-a", "-F",
    "#{session_name}\t#{pane_index}\t#{pane_pid}"])).stdout,
  homeOf = (pid) => engineHomeOfPane(pid),
} = {}) {
  let stdout;
  try { stdout = await listPanes(); } catch { return null; }
  return parsePaneList(stdout).flatMap((pane) => {
    const live = homeOf(pane.pid);
    return live ? [{ key: pane.key, ...live }] : [];
  });
}

/** WHAT: Maps each profile to the panes running on its dir. WHY: Keeps symlinked and default homes on the same account. */
export function panesByProfileKey(livePanes, profiles, { realpath = realpathSync } = {}) {
  const byKey = new Map();
  const unknown = [];
  for (const pane of livePanes || []) {
    const home = canonical(pane.home, realpath);
    const profile = profiles.find((candidate) => candidate.provider === pane.engine
      && canonical(candidate.home, realpath) === home);
    if (!profile) { unknown.push(pane); continue; }
    byKey.set(profile.key, [...(byKey.get(profile.key) || []), pane.key]);
  }
  return { byKey, unknown };
}

const memberKeys = (account) => Array.isArray(account?.sharedBy)
  ? account.sharedBy.map((member) => member.key) : [account?.profile?.key].filter(Boolean);

/**
 * WHAT: Maps the panes that run on each account into a quota snapshot.
 * WHY: Keeps the account Claude and Codex spend right now visible next to its quota.
 */
export function withPanesInUse(snapshot, livePanes, profiles, options = {}) {
  if (!Array.isArray(livePanes) || !Array.isArray(snapshot?.accounts)) return snapshot;
  const { byKey, unknown } = panesByProfileKey(livePanes, profiles, options);
  return {
    ...snapshot,
    accounts: snapshot.accounts.map((account) => ({
      ...account,
      inUse: memberKeys(account).flatMap((key) => byKey.get(key) || []),
    })),
    panesOnUnknownLogin: unknown.map((pane) => ({ key: pane.key, engine: pane.engine, home: pane.home })),
  };
}

/** WHAT: Reads the quota snapshot and the panes running on each account in one pass. WHY: Keeps the CLI and Discord views identical. */
export async function readQuotaSnapshotWithPanes({
  readSnapshot = readQuotaSnapshot,
  readPanes = readLivePaneHomes,
  profiles = quotaAccountCatalog(),
} = {}) {
  const [snapshot, panes] = await Promise.all([readSnapshot(), readPanes()]);
  return withPanesInUse(snapshot, panes, profiles);
}
