// Weekly subscription quota for the engines the fleet runs on.
//
// Claude: the same OAuth usage endpoint the CLI's /usage screen reads,
// authenticated with the locally stored Claude Code credentials.
// Codex: rate_limits events that every Codex turn already appends to its
// rollout jsonl, read from the tail of the newest session files.
//
// Pure normalizers with injected IO so contracts are testable offline.

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readTailWindow } from "./jsonl-reader.mjs";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
export const CODEX_TAIL_BYTES = 256 * 1024;
export const CODEX_SCAN_FILES = 12;

const clampPercent = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(100, Math.max(0, Math.round(numeric * 10) / 10));
};

// ---------- Claude ----------

export function normalizeClaudeUsage(payload, fetchedAt) {
  const rows = Array.isArray(payload?.limits) ? payload.limits : [];
  const limits = rows
    .map((row) => {
      const scopeName = row?.scope?.model?.display_name || null;
      const kind = String(row?.kind || "unknown");
      return {
        id: kind === "weekly_scoped" && scopeName
          ? `weekly_${scopeName.toLowerCase().replace(/[^a-z0-9]+/gu, "_")}`
          : kind,
        kind,
        scopeName,
        usedPercent: clampPercent(row?.percent),
        resetsAt: typeof row?.resets_at === "string" ? row.resets_at : null,
        severity: typeof row?.severity === "string" ? row.severity : null,
        isActive: row?.is_active === true,
      };
    })
    .filter((limit) => limit.usedPercent !== null);
  if (limits.length === 0) {
    return { ok: false, engine: "claude", error: "no_limits_in_response", fetchedAt };
  }
  return { ok: true, engine: "claude", fetchedAt, limits };
}

export async function readClaudeQuota({
  credentialsPath = join(homedir(), ".claude", ".credentials.json"),
  fetchImpl = fetch,
  timeoutMs = 10_000,
  now = Date.now,
} = {}) {
  let credentials;
  try {
    credentials = JSON.parse(readFileSync(credentialsPath, "utf-8"))?.claudeAiOauth;
  } catch {
    return { ok: false, engine: "claude", error: "credentials_unavailable" };
  }
  if (!credentials?.accessToken) {
    return { ok: false, engine: "claude", error: "credentials_unavailable" };
  }
  if (Number.isFinite(credentials.expiresAt) && credentials.expiresAt <= now()) {
    return { ok: false, engine: "claude", error: "credentials_expired" };
  }

  let response;
  try {
    response = await fetchImpl(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": CLAUDE_OAUTH_BETA,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, engine: "claude", error: "network_error" };
  }
  if (!response.ok) {
    return { ok: false, engine: "claude", error: `http_${response.status}` };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, engine: "claude", error: "invalid_response" };
  }
  return normalizeClaudeUsage(payload, new Date(now()).toISOString());
}

// ---------- Codex ----------

export function parseCodexRateLimitEvents(text) {
  const events = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.includes('"rate_limits"')) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // partial tail line or unrelated content
    }
    const rateLimits = parsed?.payload?.rate_limits;
    if (!rateLimits || typeof rateLimits !== "object") continue;
    const windows = ["primary", "secondary"].flatMap((windowId) => {
      const window = rateLimits[windowId];
      const usedPercent = clampPercent(window?.used_percent);
      if (usedPercent === null) return [];
      return [{
        id: windowId,
        usedPercent,
        windowMinutes: Number.isFinite(window.window_minutes) ? window.window_minutes : null,
        resetsAt: Number.isFinite(window.resets_at)
          ? new Date(window.resets_at * 1000).toISOString()
          : null,
      }];
    });
    if (windows.length === 0) continue;
    events.push({
      capturedAt: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
      limitId: typeof rateLimits.limit_id === "string" ? rateLimits.limit_id : "codex",
      planType: typeof rateLimits.plan_type === "string" ? rateLimits.plan_type : null,
      windows,
    });
  }
  return events;
}

function listRolloutFilesNewestFirst(sessionsRoot) {
  let entries;
  try {
    entries = readdirSync(sessionsRoot, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile()
      && entry.name.startsWith("rollout-")
      && entry.name.endsWith(".jsonl"))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .sort()
    .reverse(); // rollout filenames embed their UTC timestamp, so name order is time order
}

export function readCodexQuota({
  sessionsRoot = join(homedir(), ".codex", "sessions"),
  maxFiles = CODEX_SCAN_FILES,
  tailBytes = CODEX_TAIL_BYTES,
} = {}) {
  const files = listRolloutFilesNewestFirst(sessionsRoot).slice(0, maxFiles);
  if (files.length === 0) {
    return { ok: false, engine: "codex", error: "no_session_files" };
  }
  const latestByLimit = new Map();
  for (const file of files) {
    let tail;
    try {
      tail = readTailWindow(file, tailBytes).text;
    } catch {
      continue;
    }
    for (const event of parseCodexRateLimitEvents(tail)) {
      const existing = latestByLimit.get(event.limitId);
      if (!existing || String(event.capturedAt) > String(existing.capturedAt)) {
        latestByLimit.set(event.limitId, event);
      }
    }
  }
  if (latestByLimit.size === 0) {
    return { ok: false, engine: "codex", error: "no_rate_limit_events" };
  }
  return {
    ok: true,
    engine: "codex",
    limits: [...latestByLimit.values()]
      .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt))),
  };
}

// ---------- Snapshot ----------

export async function readQuotaSnapshot({ claude, codex, now = Date.now } = {}) {
  const [claudeQuota, codexQuota] = await Promise.all([
    readClaudeQuota(claude),
    Promise.resolve(readCodexQuota(codex)),
  ]);
  return {
    generatedAt: new Date(now()).toISOString(),
    claude: claudeQuota,
    codex: codexQuota,
  };
}
