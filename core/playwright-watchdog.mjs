import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const DEFAULT_PLAYWRIGHT_WATCHDOG_CONFIG = {
  enabled: true,
  pollMs: 60_000,
  toolTimeoutMs: 600_000,
  mcpMaxAgeMs: 3_600_000,
};

// The shared headed Chrome every agent attaches to. Unlike an MCP-owned browser
// it is not per-session, so its age says nothing about whether anyone is using
// it — see observeSharedBrowser below.
export const SHARED_BROWSER_PORT = 42089;

// A heartbeat older than this stops claiming the browser. Generous against
// agent-browser's command cadence: a pane between two screenshots still holds it.
export const HEARTBEAT_FRESH_MS = 10 * 60_000;

export function parsePlaywrightWatchdogConfig(env = process.env) {
  return {
    enabled: env.AMUX_PLAYWRIGHT_WATCHDOG_ENABLED !== "false",
    pollMs: parseInt(env.AMUX_PLAYWRIGHT_WATCHDOG_POLL_MS || DEFAULT_PLAYWRIGHT_WATCHDOG_CONFIG.pollMs, 10),
    toolTimeoutMs: parseInt(env.AMUX_PLAYWRIGHT_TOOL_TIMEOUT_MS || DEFAULT_PLAYWRIGHT_WATCHDOG_CONFIG.toolTimeoutMs, 10),
    mcpMaxAgeMs: parseInt(env.AMUX_PLAYWRIGHT_MCP_MAX_AGE_MS || DEFAULT_PLAYWRIGHT_WATCHDOG_CONFIG.mcpMaxAgeMs, 10),
  };
}

export function parsePsRows(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
      if (!m) return null;
      return {
        pid: Number(m[1]),
        ppid: Number(m[2]),
        pgid: Number(m[3]),
        sid: Number(m[4]),
        stat: m[5],
        etimes: Number(m[6]),
        cmd: m[7],
      };
    })
    .filter(Boolean);
}

export function classifyPlaywrightProcess(cmd) {
  const c = String(cmd || "").toLowerCase();
  if (c.includes(".cache/ms-playwright-mcp")) return "mcp-chrome";
  if (c.includes("--remote-debugging-port=42089") && c.includes("chrome-42089")) return "claude-cdp-chrome";
  if (c.includes("playwright-mcp") || c.includes("@playwright/mcp")) return "mcp";
  return null;
}

/**
 * WHAT: True for a process belonging to the shared agent-browser session.
 * WHY: The browser on :42089 and any MCP client pointed at it are one session.
 * Protecting the browser while killing its client still breaks the measurement.
 */
export function belongsToSharedBrowserSession(cmd, port = SHARED_BROWSER_PORT) {
  return String(cmd || "").includes(`:${port}`) || String(cmd || "").includes(`=${port}`);
}

/**
 * WHAT: Counts CDP clients attached to the shared browser from `ss` output.
 * WHY: A loopback connection appears twice, once per endpoint; only the row
 * whose LOCAL address is the CDP port is the browser's side of it.
 * NOTE: This counts every live socket, including an HTTP keep-alive left by a
 * status probe. That is deliberate — a process holding a connection is a
 * process using the browser — and measured to clear when that process exits.
 */
export function parseCdpClientCount(stdout, port = SHARED_BROWSER_PORT) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 4 && /^\d+$/.test(cols[0]))
    .filter((cols) => cols[2].endsWith(`:${port}`))
    .length;
}

/**
 * WHAT: Reads how many CDP clients hold the shared browser.
 * WHY: A probe that could not run is not evidence of an idle browser, so a
 * failure returns known:false and the caller must skip rather than kill blind.
 */
export function readCdpClientCount({
  port = SHARED_BROWSER_PORT,
  exec = () => execFileSync("ss", ["-tn", "state", "established"], { encoding: "utf8" }),
} = {}) {
  try {
    return { known: true, clients: parseCdpClientCount(exec(), port), error: null };
  } catch (err) {
    return { known: false, clients: null, error: err.message };
  }
}

/**
 * WHAT: Reads agent-browser's ownership claim.
 * WHY: A missing file is a browser nobody claims, which is a fact. A file that
 * exists but cannot be parsed is an unknown, which must protect instead.
 */
export function readAgentBrowserHeartbeat({
  path = process.env.AMUX_AGENT_BROWSER_HEARTBEAT || join(homedir(), ".agentmux", "agent-browser-heartbeat.json"),
  now = Date.now(),
} = {}) {
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { known: true, ageMs: null, error: null };
  }
  try {
    const age = now - new Date(JSON.parse(raw).ts).getTime();
    if (!Number.isFinite(age)) throw new TypeError("heartbeat has no usable ts");
    return { known: true, ageMs: age, error: null };
  } catch (err) {
    return { known: false, ageMs: null, error: err.message };
  }
}

/** WHAT: One reading of whether the shared browser is in use. */
export function observeSharedBrowser({ port = SHARED_BROWSER_PORT, cdp, heartbeat } = {}) {
  const clients = cdp ?? readCdpClientCount({ port });
  const beat = heartbeat ?? readAgentBrowserHeartbeat();
  return {
    known: clients.known && beat.known,
    clients: clients.clients,
    heartbeatAgeMs: beat.ageMs,
    heartbeatFresh: beat.ageMs !== null && beat.ageMs <= HEARTBEAT_FRESH_MS,
    error: clients.error || beat.error,
  };
}

/**
 * WHAT: Decides whether one aged process may be reaped, and says why.
 * WHY: Age alone declared a live shared browser dead and killed an active
 * measurement (SRC-0136). Age is now necessary, never sufficient: the shared
 * session also has to be provably idle and unclaimed.
 */
export function classifyReapDecision(proc, { activity }) {
  if (!belongsToSharedBrowserSession(proc.cmd)) {
    return { reap: true, reason: "ephemeral MCP process past max age" };
  }
  if (!activity || !activity.known) {
    return { reap: false, reason: `shared browser activity unreadable (${activity?.error || "not observed"})` };
  }
  if (activity.clients > 0) {
    return { reap: false, reason: `shared browser has ${activity.clients} attached CDP client(s)` };
  }
  if (activity.heartbeatFresh) {
    return { reap: false, reason: `agent-browser heartbeat is ${Math.round(activity.heartbeatAgeMs / 1000)}s old` };
  }
  return { reap: true, reason: "shared browser past max age, no CDP client, no fresh heartbeat" };
}

/**
 * WHAT: True when the process at this pid is still the one that was scanned.
 * WHY: A pid is reused. Elapsed time that went backwards is a different
 * process wearing the same number, and killing it is killing a stranger.
 */
export function sameProcessGeneration(before, after) {
  return Boolean(after) && after.pid === before.pid && after.cmd === before.cmd && after.etimes >= before.etimes;
}

export function findStalePlaywrightProcesses(rows, { maxAgeMs, nowPid = process.pid } = {}) {
  const maxAgeSeconds = Math.max(1, Math.floor((maxAgeMs ?? DEFAULT_PLAYWRIGHT_WATCHDOG_CONFIG.mcpMaxAgeMs) / 1000));
  return rows
    .map((row) => ({ ...row, kind: classifyPlaywrightProcess(row.cmd) }))
    .filter((row) => row.kind)
    .filter((row) => row.pid !== nowPid)
    .filter((row) => row.etimes >= maxAgeSeconds)
    .sort((a, b) => b.etimes - a.etimes || a.pid - b.pid);
}

export function readProcessRows() {
  const stdout = execFileSync("ps", ["-eo", "pid,ppid,pgid,sid,stat,etimes,cmd"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
  });
  return parsePsRows(stdout);
}

export function reapStalePlaywrightProcesses({
  maxAgeMs = DEFAULT_PLAYWRIGHT_WATCHDOG_CONFIG.mcpMaxAgeMs,
  dryRun = false,
  signal = "SIGTERM",
  rows = null,
  kill = (pid, sig) => process.kill(pid, sig),
  observe = observeSharedBrowser,
  // Always a genuine second read. A caller that pinned the world with `rows`
  // gets that same world back, but production re-reads ps so the recheck can
  // actually observe a change.
  rescan = rows ? () => rows : readProcessRows,
} = {}) {
  const stale = findStalePlaywrightProcesses(rows || readProcessRows(), { maxAgeMs });
  const activity = stale.some((proc) => belongsToSharedBrowserSession(proc.cmd)) ? observe() : null;
  const result = {
    scanned: rows ? rows.length : null,
    candidates: stale.length,
    eligible: 0,
    killed: 0,
    failed: 0,
    skipped: [],
    activity,
    dryRun,
    maxAgeMs,
    signal,
    processes: stale,
    errors: [],
  };

  const decided = stale.map((proc) => ({ proc, ...classifyReapDecision(proc, { activity }) }));
  for (const { proc, reap, reason } of decided) {
    if (!reap) result.skipped.push({ pid: proc.pid, kind: proc.kind, ageS: proc.etimes, reason });
  }
  result.eligible = decided.filter((d) => d.reap).length;

  if (dryRun) return result;

  // Everything above was decided from one scan. Between that scan and this
  // kill an agent can have attached, so re-prove both identity and idleness
  // for the process we are about to signal.
  for (const { proc } of decided.filter((d) => d.reap)) {
    const current = rescan().find((row) => row.pid === proc.pid);
    if (!sameProcessGeneration(proc, current)) {
      result.skipped.push({ pid: proc.pid, kind: proc.kind, ageS: proc.etimes, reason: "process identity changed after scan" });
      continue;
    }
    const recheck = classifyReapDecision(proc, {
      activity: belongsToSharedBrowserSession(proc.cmd) ? observe() : null,
    });
    if (!recheck.reap) {
      result.skipped.push({ pid: proc.pid, kind: proc.kind, ageS: proc.etimes, reason: `${recheck.reason} (arrived after scan)` });
      continue;
    }
    try {
      kill(proc.pid, signal);
      result.killed++;
    } catch (err) {
      result.failed++;
      result.errors.push(`${proc.pid}: ${err.message}`);
    }
  }
  return result;
}

export function formatPlaywrightReapResult(result) {
  const mins = Math.round(result.maxAgeMs / 60_000);
  if (result.candidates === 0) return `playwright-watchdog: no stale MCP/browser processes older than ${mins}m`;
  const action = result.dryRun ? "would reap" : "reaped";
  const failed = result.failed ? `, ${result.failed} failed` : "";
  const count = result.dryRun ? result.eligible : result.killed;
  const a = result.activity;
  const observed = a
    ? ` | shared browser: ${a.known ? `${a.clients} client(s)` : `activity UNREADABLE (${a.error})`}, heartbeat ${
      a.heartbeatAgeMs === null ? "absent" : `${Math.round(a.heartbeatAgeMs / 1000)}s old`}`
    : "";
  const skipped = result.skipped
    .map((s) => `\n  skipped pid ${s.pid} (${s.kind}, age ${s.ageS}s): ${s.reason}`)
    .join("");
  return `playwright-watchdog: ${action} ${count}/${result.candidates} stale process(es) older than ${mins}m${failed}${observed}${skipped}`;
}

export function detectActivePlaywrightTool(content, status = "unknown") {
  // A completed turn can leave both tool rows and ordinary Playwright prose in
  // scrollback. Only a live progress footer makes that residue actionable.
  if (status !== "working") return null;
  const lines = String(content || "").split(/\r?\n/);
  const tail = lines.slice(-80);
  let lastPlaywright = null;
  let lastOtherTool = -1;

  for (let i = 0; i < tail.length; i++) {
    const line = tail[i].replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim();
    if (/^[●○]\s*(Bash|Read|Edit|Write|Grep|Glob|Task|WebFetch|TodoWrite|amux|git|npm|pnpm|python)\b/i.test(line)) {
      lastOtherTool = i;
    }
    if (/^[●○]\s*(?:playwright\s*-\s*.+\(MCP\)|playwright_(navigate|click|screenshot|evaluate|fill|press)\b)/i.test(line)) {
      lastPlaywright = { index: i, signature: line.replace(/\s+/g, " ").slice(0, 240) };
    }
  }

  if (!lastPlaywright || lastOtherTool > lastPlaywright.index) return null;
  return lastPlaywright.signature;
}
