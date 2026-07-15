// amux doctor: surface the SILENT failure modes in one table. Every check
// answers a question that otherwise fails invisibly:
//   - is the bridge process alive, and supervised (bin/start.sh)?
//   - is its event loop actually beating (hung vs healthy)?
//   - is it running the repo's CURRENT code (the stale-bridge trap)?
//   - are the Claude Code hooks installed and their script present?
//   - is the event ledger alive and rotating?
//   - does tmux answer when at least one configured project still needs it?
//
// Pure functions + injected I/O so every rule is unit-testable; the CLI
// wrapper (cmdDoctor) does the real reads.

import { classifyHeartbeat } from "./heartbeat.mjs";
import { classifyGuardHeartbeat } from "./guard-heartbeat.mjs";

export const OK = "ok";
export const WARN = "warn";
export const FAIL = "fail";
export const SUGGESTIONS_BRIDGE_STALE_MS = 5 * 60 * 1000;

const check = (name, status, detail, hint = "") => ({ name, status, detail, hint });

function suggestionsSyncDetail(lastSuccessfulSyncAt, now) {
  if (!Number.isFinite(lastSuccessfulSyncAt)) return "comment bridge has never completed a sync";
  const ageMs = Math.max(0, now - lastSuccessfulSyncAt);
  const age = ageMs < 60_000
    ? `${Math.round(ageMs / 1000)}s`
    : ageMs < 60 * 60_000
      ? `${Math.round(ageMs / 60_000)}m`
      : `${Math.round(ageMs / (60 * 60_000))}h`;
  return `comment bridge synced ${age} ago at ${new Date(lastSuccessfulSyncAt).toISOString()}`;
}

/** One row joins live read-token reachability with the durable bridge success cursor. */
export function checkSuggestionsBoard({
  configured = true,
  probe = null,
  lastSuccessfulSyncAt = null,
  now = Date.now(),
  staleAfterMs = SUGGESTIONS_BRIDGE_STALE_MS,
} = {}) {
  if (!configured) {
    return check("suggestions board", WARN, "comment bridge is not configured",
      "install it: bin/install-suggestions-comment-bridge.sh install");
  }
  const freshness = suggestionsSyncDetail(lastSuccessfulSyncAt, now);
  if (!probe?.ok) {
    const status = Number.isSafeInteger(probe?.status) ? `HTTP ${probe.status}` : "probe failed";
    const error = String(probe?.error || "unknown error").replace(/[\r\n\t]+/gu, " ").slice(0, 180);
    const hint = new Set([401, 403]).has(probe?.status)
      ? "verify deployed READ_TOKEN matches ~/.config/agent/suggestions-read-token; rerun amux doctor"
      : probe?.status >= 500
        ? "check Suggestions deployment health/logs, then rerun amux doctor"
        : "check bridge config, read-token file, and network; rerun amux doctor";
    return check("suggestions board", FAIL,
      `${status}${error ? ` (${error})` : ""} · ${freshness}`, hint);
  }
  if (!Number.isFinite(lastSuccessfulSyncAt)) {
    return check("suggestions board", FAIL, `HTTP ${probe.status || 200} · ${freshness}`,
      "run bin/suggestions-comment-bridge-cron.sh once and inspect its log");
  }
  const ageMs = Math.max(0, now - lastSuccessfulSyncAt);
  if (ageMs > staleAfterMs) {
    return check("suggestions board", FAIL, `HTTP ${probe.status || 200} · ${freshness}`,
      "comment bridge is stale; inspect its cron entry/log and run it once");
  }
  return check("suggestions board", OK,
    `HTTP ${probe.status || 200} (${probe.projectId || "board"}) · ${freshness}`);
}

/** Exact Cloudflare rows-read evidence must be visible before its configured cliff. */
export function checkSuggestionsRowsRead({ entry, now = Date.now() } = {}) {
  const classified = classifyGuardHeartbeat(entry, { now });
  if (classified.state !== "ok") return null;
  const metrics = classified.beat?.metrics;
  const tier = metrics?.status;
  if (tier === "failed") {
    return check("suggestions rows read", FAIL,
      `analytics failed (${String(metrics.error || "unknown").slice(0, 160)})`,
      "inspect Suggestions usage watcher credentials/logs; do not infer usage from request counts");
  }
  if (!new Set(["ok", "warning", "critical", "exhausted"]).has(tier)
    || !Number.isFinite(metrics?.rowsRead) || !Number.isFinite(metrics?.budgetRows)
    || !Number.isFinite(metrics?.ratio) || typeof metrics?.periodKey !== "string") {
    return check("suggestions rows read", FAIL, "analytics heartbeat is malformed",
      "inspect suggestions-usage guard heartbeat and watcher version");
  }
  const detail = `${Number(metrics.rowsRead).toLocaleString("en-US")} / `
    + `${Number(metrics.budgetRows).toLocaleString("en-US")} (${Math.round(metrics.ratio * 10_000) / 100}%) `
    + `for ${metrics.periodKey}`;
  if (tier === "exhausted") {
    return check("suggestions rows read", FAIL, `EXHAUSTED · ${detail}`,
      "stop avoidable board load and inspect Cloudflare Analytics; attribution is still unknown");
  }
  if (tier === "warning" || tier === "critical") {
    return check("suggestions rows read", WARN, `${tier.toUpperCase()} · ${detail}`,
      "inspect Cloudflare Analytics before the configured rows-read budget is exhausted");
  }
  return check("suggestions rows read", OK, detail);
}

export function checkBridgeProcess({ pids, supervised }) {
  if (!pids.length) {
    return check("bridge process", FAIL, "not running",
      "start it: amux serve (or bash bin/start.sh)");
  }
  if (pids.length > 1) {
    return check("bridge process", WARN, `${pids.length} instances (${pids.join(", ")})`,
      "two bridges double-mirror Discord; kill the older one");
  }
  return supervised
    ? check("bridge process", OK, `pid ${pids[0]}, supervised by start.sh`)
    : check("bridge process", WARN, `pid ${pids[0]}, UNSUPERVISED`,
        "a crash will not auto-restart; start via amux serve / bin/start.sh");
}

/** WHAT: Describes who owns bridge restart policy. WHY: Keeps manual stops distinguishable from silent daemon failure. */
export function checkBridgeMode({ mode, running }) {
  if (mode === "manual") {
    return check("bridge mode", OK, running
      ? "manual · no dead-stack autostart"
      : "manual · waiting for `amux serve`");
  }
  if (mode === "stopped") {
    return running
      ? check("bridge mode", WARN, "stopped policy but process is still alive", "run `amux stop` again")
      : check("bridge mode", OK, "stopped intentionally");
  }
  return check("bridge mode", OK, "managed · detached auto-recovery");
}

export function checkHeartbeatHealth({ beat, repoVersion, pidAlive, now = Date.now() }) {
  const hb = classifyHeartbeat(beat, { repoVersion, pidAlive, now });
  switch (hb.state) {
    case "ok":
      return check("bridge heartbeat", OK, `beating (${Math.round(hb.ageMs / 1000)}s ago), v${beat.version}`);
    case "stale-code":
      return check("bridge code", WARN, `bridge runs v${hb.running}, repo is v${hb.repo}`,
        "restart to activate: /restart in Discord (or amux stop && amux serve)");
    case "hung":
      return check("bridge heartbeat", FAIL, `pid alive but last beat ${Math.round(hb.ageMs / 60000)} min ago`,
        "event loop is stuck: kill -9 the pid (supervisor restarts it; TERM/INT would stop the whole stack)");
    case "dead":
      return check("bridge heartbeat", FAIL, "stale beat and no live pid",
        "start it: amux serve");
    default:
      return check("bridge heartbeat", WARN, "no heartbeat file",
        "bridge predates heartbeat support: restart it once");
  }
}

/**
 * Exactly one supervisor should own the bridge. Two means an orphan — the
 * observed case (2026-07-10): the watchdog cron nohup-spawned a start.sh
 * without node in PATH and it crash-looped every 10s for 23h while doctor
 * showed all green, because the healthy tmux-hosted stack masked it.
 * crashLooping = bridge.log ends in a fresh "crashed (exit ...)" line —
 * only orphans write there (the tmux supervisor logs to its pane).
 */
export function checkSupervisors({ pids, crashLooping = false }) {
  if (crashLooping) {
    return check("supervisor", FAIL, "bridge.log ends in a fresh crash line — a supervisor is crash-looping",
      "find it: pgrep -af start.sh; keep the supervisor whose child owns the live bridge pid");
  }
  if (pids.length > 1) {
    return check("supervisor", FAIL, `${pids.length} start.sh supervisors (${pids.join(", ")}) — an orphan is burning cycles`,
      "keep the supervisor whose child owns the live bridge pid, stop the rest");
  }
  return null; // 0 or 1: checkBridgeProcess already covers supervision state
}

export function checkHooksInstalled({ settings, hookFileExists }) {
  const entries = [];
  for (const [event, list] of Object.entries(settings?.hooks || {})) {
    for (const e of list || []) {
      for (const h of e.hooks || []) {
        if (/amux-hook\.mjs/.test(h.command || "")) entries.push(event);
      }
    }
  }
  if (!entries.length) {
    return check("claude hooks", FAIL, "amux-hook not in ~/.claude/settings.json",
      "install: node bin/install-hooks.mjs");
  }
  if (!hookFileExists) {
    return check("claude hooks", FAIL, `installed for ${entries.length} events but the script is MISSING`,
      "repo moved? re-run: node bin/install-hooks.mjs");
  }
  // SessionStart feeds the session_start ledger rows (timeline/ps state)
  // and carries the resume-hint (1.20.52). Missing registration silently
  // turns both off.
  if (!entries.includes("SessionStart")) {
    return check("claude hooks", FAIL, `SessionStart not registered (only: ${entries.join(", ")}) — session_start ledger rows and resume-hints are OFF`,
      "re-run: node bin/install-hooks.mjs");
  }
  return check("claude hooks", OK, `installed (${entries.join(", ")}) — resume-hint via SessionStart`);
}

export function checkLedger({ stat, now = Date.now(), maxBytes = 8 * 1024 * 1024 }) {
  if (!stat) {
    return check("event ledger", WARN, "no events.jsonl yet",
      "fills as panes with hooks start new sessions; fine on a fresh install");
  }
  if (stat.size > maxBytes * 1.5) {
    return check("event ledger", WARN, `${Math.round(stat.size / 1e6)}MB — rotation is not keeping up`,
      "check [amux-events] rotation errors in the hook stderr");
  }
  const ageMin = Math.round((now - stat.mtimeMs) / 60000);
  return check("event ledger", OK, `${Math.round(stat.size / 1024)}KB, last event ${ageMin} min ago`);
}

/**
 * Context truth relies on Claude Code's statusline pushing its own percent
 * to os.tmpdir()/claude-ctx-<session>.json (core/context.mjs). If that
 * channel dies silently (statusline replaced/updated without the tee),
 * every consumer falls back to scrape/jsonl reconstruction — the family
 * that produced 0%/33%/100% disagreement about one pane (2026-07-08).
 * Surface the coverage so the fallback is a visible state, not a silent one.
 */
export function checkContextBridge({ claudePanes, pushing }) {
  if (!claudePanes) return check("context bridge", OK, "no claude panes configured");
  if (pushing === 0) {
    return check("context bridge", WARN,
      `0/${claudePanes} claude panes push statusline context`,
      "context %% falls back to scrape/jsonl; verify the statusline writes /tmp/claude-ctx-<session>.json");
  }
  return check("context bridge", OK, `${pushing}/${claudePanes} claude panes push fresh context`);
}

export function checkTmux({ sessions, error, required = true }) {
  if (!required) return check("tmux", OK, "not required by native-only fleet");
  if (error) {
    return check("tmux", FAIL, `socket not answering: ${error}`,
      "agents unreachable; is tmux running on the amux socket?");
  }
  return check("tmux", OK, `${sessions.length} session${sessions.length === 1 ? "" : "s"} (${sessions.join(", ")})`);
}

/** tmux added paste-buffer -p (bracketed-paste framing) in 3.2. */
export function checkTmuxVersion({ version, minimumMajor = 3, minimumMinor = 2, required = true }) {
  if (!required) return check("tmux version", OK, "not required by native-only fleet");
  const label = String(version || "").trim();
  const match = label.match(/(\d+)\.(\d+)/);
  if (!match) {
    return check("tmux version", FAIL, `${label || "unknown"}; need 3.2+ for safe long-prompt paste`,
      "upgrade tmux before starting the bridge");
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const supported = major > minimumMajor || (major === minimumMajor && minor >= minimumMinor);
  return supported
    ? check("tmux version", OK, `${label.replace(/^tmux\s+/i, "")} (bracketed paste supported)`)
    : check("tmux version", FAIL, `${label.replace(/^tmux\s+/i, "")} is too old; need 3.2+ for safe long-prompt paste`,
        "upgrade tmux before starting the bridge");
}

export function checkConfig({ agents, error }) {
  if (error) {
    return check("config", FAIL, `agentmux.yaml unparseable: ${error}`, "amux edit");
  }
  return check("config", OK, `${agents.length} agents configured`);
}

export function checkNativeRuntime({ configured = 0, online = 0, running = 0, details = [] } = {}) {
  if (!configured) return null;
  if (online !== configured) {
    return check(
      "native runtime",
      FAIL,
      `${online}/${configured} configured runtime${configured === 1 ? "" : "s"} online${details.length ? ` (${details.join(", ")})` : ""}`,
      "run `amux runtime status` and start the missing runtime; native targets fail closed",
    );
  }
  return check(
    "native runtime",
    OK,
    `${online}/${configured} online · ${running} active turn${running === 1 ? "" : "s"}`,
  );
}

/** Durable prompts must be visible even when the bridge is intentionally off. */
export function checkDeliveryQueue({ stats, bridgeRunning, now = Date.now() }) {
  const supplementary = Number(stats?.pendingNotices || 0)
    + Number(stats?.cancellationRequests || 0);
  if (!stats?.total && !supplementary) return check("delivery queue", OK, "empty");
  const age = stats.oldestCreatedAt
    ? `${Math.max(0, Math.round((now - stats.oldestCreatedAt) / 1000))}s`
    : "";
  const oldest = stats.oldestJob?.id
    ? `, oldest ${stats.oldestJob.id} → ${stats.oldestJob.agentName}:${stats.oldestJob.pane}${age ? ` (${age})` : ""}`
    : age ? `, oldest ${age}` : "";
  const parts = [
    stats.pending ? `${stats.pending} pending` : null,
    stats.pasting ? `${stats.pasting} pasting` : null,
    stats.drafted ? `${stats.drafted} drafted` : null,
    stats.submitted ? `${stats.submitted} submitted` : null,
    stats.blocked ? `${stats.blocked} blocked` : null,
    stats.pendingNotices ? `${stats.pendingNotices} terminal notice${stats.pendingNotices === 1 ? "" : "s"}` : null,
    stats.cancellationRequests ? `${stats.cancellationRequests} cancel request${stats.cancellationRequests === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(", ");
  if (!bridgeRunning) {
    return check("delivery queue", WARN, `${parts}${oldest}; bridge is stopped`,
      "run `amux queue`, then start the bridge to resume the durable FIFO");
  }
  if (stats.blocked || stats.pasting || stats.drafted || supplementary) {
    return check("delivery queue", WARN, `${parts}${oldest}`,
      "run `amux queue`; the broker preserves the FIFO head until the composer is safe");
  }
  return check("delivery queue", OK, `${parts}${oldest}; broker draining · inspect with amux queue`);
}

/** Scheduled guards fail silently unless their own successful sweeps are observable. */
export function checkGuardCronHeartbeats({ heartbeats, now = Date.now() }) {
  const rows = heartbeats.map((entry) => classifyGuardHeartbeat(entry, { now }));
  if (!rows.length) {
    return check("guard crons", FAIL, "RED 0/0: registry empty",
      "restore the canonical guard registry before relying on cron liveness");
  }
  const red = rows.filter((entry) => entry.state !== "ok");
  if (red.length) {
    const detail = red.map((entry) => {
      if (entry.state === "missing") return `${entry.key} missing`;
      if (entry.state === "invalid") return `${entry.key} invalid`;
      return `${entry.key} ${Math.floor(entry.ageMs / 60000)}m > 2×${Math.ceil(entry.intervalSec / 60)}m`;
    }).join(", ");
    return check("guard crons", FAIL, `RED ${red.length}/${rows.length}: ${detail}`,
      "inspect cron/logs; a heartbeat is written only after a successful sweep");
  }
  const oldest = [...rows].sort((left, right) => right.ageMs - left.ageMs)[0];
  return check("guard crons", OK,
    `${rows.length}/${rows.length} fresh · oldest ${oldest.key} ${Math.floor(oldest.ageMs / 60000)}m ago`);
}

/** Worst status wins for the exit code: fail > warn > ok. */
export function overallStatus(checks) {
  if (checks.some((c) => c.status === FAIL)) return FAIL;
  if (checks.some((c) => c.status === WARN)) return WARN;
  return OK;
}

const ICONS = { [OK]: "✅", [WARN]: "⚠️", [FAIL]: "❌" };

export function formatDoctorReport(checks) {
  const lines = [];
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    lines.push(`${ICONS[c.status]}  ${c.name.padEnd(width)}  ${c.detail}`);
    if (c.hint && c.status !== OK) lines.push(`   ${" ".repeat(width)}  → ${c.hint}`);
  }
  return lines.join("\n");
}
