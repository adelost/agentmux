import { execFileSync } from "child_process";

export const DEFAULT_PLAYWRIGHT_WATCHDOG_CONFIG = {
  enabled: true,
  pollMs: 60_000,
  toolTimeoutMs: 600_000,
  mcpMaxAgeMs: 3_600_000,
};

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
} = {}) {
  const stale = findStalePlaywrightProcesses(rows || readProcessRows(), { maxAgeMs });
  const result = {
    scanned: rows ? rows.length : null,
    candidates: stale.length,
    killed: 0,
    failed: 0,
    dryRun,
    maxAgeMs,
    signal,
    processes: stale,
    errors: [],
  };

  if (dryRun) return result;

  for (const proc of stale) {
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
  return `playwright-watchdog: ${action} ${result.dryRun ? result.candidates : result.killed}/${result.candidates} stale process(es) older than ${mins}m${failed}`;
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
