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
/** WHAT: Carries the minimum usable tmux pane width. WHY: Keeps doctor and its regression boundary synchronized. */
export const TMUX_MIN_PANE_COLUMNS = 60;
/** WHAT: Carries the minimum usable tmux pane height. WHY: Keeps doctor and its regression boundary synchronized. */
export const TMUX_MIN_PANE_ROWS = 20;

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
    return check("tmux", FAIL, `health query failed: ${error}`,
      "agents may be unreachable; inspect the amux tmux socket");
  }
  return check("tmux", OK, `${sessions.length} session${sessions.length === 1 ? "" : "s"} (${sessions.join(", ")})`);
}

/** WHAT: Parses one tab-delimited tmux health result. WHY: Rejects partial fields before doctor can report false health. */
function tmuxRows(stdout, fields, label) {
  const lines = String(stdout || "").trim().split("\n").filter(Boolean);
  return lines.map((line) => {
    const values = line.split("\t");
    if (values.length !== fields.length) throw new Error(`invalid ${label} observation: ${line}`);
    return Object.fromEntries(fields.map((field, index) => [field, values[index]]));
  });
}

/** WHAT: Fetches tmux session attachments and every pane's geometry. WHY: Prevents the two coupled health rules from observing separate truths. */
export async function observeTmuxFleet(tmux) {
  try {
    const [sessionResult, paneResult] = await Promise.all([
      tmux("list-sessions -F '#{session_name}\t#{session_attached}'"),
      tmux("list-panes -a -F '#{session_name}\t#{pane_index}\t#{pane_width}\t#{pane_height}'"),
    ]);
    const sessions = tmuxRows(sessionResult.stdout, ["name", "attached"], "session")
      .map((session) => ({ ...session, attached: Number(session.attached) }));
    const panes = tmuxRows(paneResult.stdout, ["session", "pane", "width", "height"], "pane")
      .map((pane) => ({
        ...pane,
        pane: Number(pane.pane),
        width: Number(pane.width),
        height: Number(pane.height),
      }));
    if (sessions.some((session) => !Number.isSafeInteger(session.attached) || session.attached < 0)
      || panes.some((pane) => ![pane.pane, pane.width, pane.height].every(Number.isSafeInteger))) {
      throw new Error("tmux returned non-integer health fields");
    }
    return { sessions, panes, error: null };
  } catch (error) {
    return { sessions: [], panes: [], error: String(error.message || error).split("\n")[0] };
  }
}

/** WHAT: Calculates doctor severity for tmux pane geometry. WHY: Prevents unreadable terminal frames from masquerading as operator-ready. */
export function checkTmuxPaneGeometry({ panes = [], error = null, required = true } = {}) {
  if (!required || error) return null;
  const undersized = panes.filter((pane) => pane.width < TMUX_MIN_PANE_COLUMNS
    || pane.height < TMUX_MIN_PANE_ROWS);
  if (!panes.length) {
    return check("tmux pane geometry", FAIL, "no pane geometry observed",
      "attach a client or inspect the amux tmux socket, then rerun amux doctor");
  }
  if (!undersized.length) {
    return check("tmux pane geometry", OK,
      `${panes.length}/${panes.length} panes at least ${TMUX_MIN_PANE_COLUMNS}x${TMUX_MIN_PANE_ROWS}`);
  }
  const detail = undersized.map((pane) => `${pane.session}:${pane.pane} ${pane.width}x${pane.height}`).join(", ");
  return check("tmux pane geometry", FAIL,
    `${undersized.length}/${panes.length} below operator minimum ${TMUX_MIN_PANE_COLUMNS}x${TMUX_MIN_PANE_ROWS}: ${detail}`,
    "attach a client, or run tmux resize-window -t SESSION -x 340 -y 100 on the amux socket");
}

/** WHAT: Calculates doctor severity for tmux client attachment. WHY: Keeps detached-resurrection risk visible even when pane dimensions are currently safe. */
export function checkTmuxClients({ sessions = [], error = null, required = true } = {}) {
  if (!required || error) return null;
  const detached = sessions.filter((session) => session.attached === 0);
  if (!detached.length) return check("tmux clients", OK, `${sessions.length}/${sessions.length} sessions attached`);
  return check("tmux clients", WARN,
    `${detached.length}/${sessions.length} sessions without a client: ${detached.map((session) => session.name).join(", ")}`,
    "attach to the session when using its TUI; headless sessions require a safe tmux default-size");
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

const runtimeKey = (runtime = {}) => {
  if (Number.isSafeInteger(Number(runtime.port))) return `local:${Number(runtime.port)}`;
  try {
    const parsed = new URL(runtime.url);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) {
      return `local:${port}`;
    }
    return parsed.origin;
  } catch {
    return String(runtime.url || "unknown");
  }
};

/** Every managed runtime is a row; configured-but-unmanaged runtimes cannot hide. */
export function checkNativeRuntimeFleet({ managed = [], configured = [], discoveryError = null } = {}) {
  if (!managed.length && !configured.length && !discoveryError) return [];
  const configuredByKey = new Map(configured.map((runtime) => [runtimeKey(runtime), runtime]));
  const managedKeys = new Set(managed.map(runtimeKey));
  const onlineManaged = managed.filter((runtime) => runtime.online).length;
  const running = managed.reduce((total, runtime) => total + Number(runtime.health?.running || 0), 0);
  const managedFailure = managed.some((runtime) => !runtime.online);
  const configuredFailure = configured.some((runtime) => !runtime.online);
  const unmanagedConfigured = configured.some((runtime) => runtime.online && !managedKeys.has(runtimeKey(runtime)));
  const status = discoveryError || managedFailure || configuredFailure ? FAIL : unmanagedConfigured ? WARN : OK;
  const rows = [check(
    "native runtimes",
    status,
    `${managed.length} managed · ${onlineManaged} online · ${running} active turn${running === 1 ? "" : "s"} · ${configured.length} configured`,
    status === FAIL
      ? "run `amux runtime status`; every configured runtime must be online and every managed process must answer health"
      : status === WARN
        ? "an online configured runtime is not owned by the local service manager"
        : null,
  )];

  if (discoveryError) {
    rows.push(check(
      "native discovery",
      FAIL,
      `managed runtime enumeration failed · ${discoveryError}`,
      "inspect ~/.agentmux ownership records; a runtime may be running without appearing above",
    ));
  }

  for (const runtime of managed) {
    const health = runtime.health ?? {};
    const port = Number(runtime.port);
    const isConfigured = configuredByKey.has(runtimeKey(runtime));
    rows.push(check(
      `native :${port}`,
      runtime.online ? OK : FAIL,
      `boot ${health.bootId || "unavailable"} · ${Number.isFinite(Number(health.agents)) ? Number(health.agents) : "?"} agents`
      + ` · ${Number.isFinite(Number(health.running)) ? Number(health.running) : "?"} active`
      + ` · data ${runtime.paths?.dataDir || "unknown"} · ${isConfigured ? "configured" : "managed-only"}`,
      runtime.online ? null : `inspect ${runtime.paths?.logPath || "the runtime log"}`,
    ));
  }

  for (const runtime of configured) {
    if (managedKeys.has(runtimeKey(runtime))) continue;
    let label = runtime.url || "unknown";
    try { label = `:${new URL(runtime.url).port || "80"}`; } catch {}
    rows.push(check(
      `native ${label}`,
      runtime.online ? WARN : FAIL,
      runtime.online
        ? `online but unmanaged · boot ${runtime.health?.bootId || "unavailable"} · ${Number(runtime.health?.agents ?? 0)} agents`
        : `configured but offline${runtime.error ? ` · ${runtime.error}` : ""}`,
      runtime.online
        ? "adopt this runtime into the service manager or remove the stale configured URL"
        : "start the configured runtime; native targets fail closed",
    ));
  }
  return rows;
}

/** Durable prompts must be visible even when the bridge is intentionally off. */
export function checkDeliveryQueue({ stats, bridgeRunning, now = Date.now() }) {
  const supplementary = Number(stats?.pendingNotices || 0)
    + Number(stats?.cancellationRequests || 0);
  // Queue movement is not delivery. A target that let consecutive receipt
  // budgets expire without ingesting anything is the one state this row must
  // never report as draining, and it outranks every count below including the
  // empty fast path: the delivery breaker exists precisely to keep such a
  // target's queue short, so an empty queue is its symptom, not its absence.
  const notIngesting = stats?.notIngestingTargets || [];
  if (notIngesting.length) {
    const targets = notIngesting
      .map((target) => `${target.agentName}:${target.pane} (${target.unverifiedStreak} budgets)`)
      .join(", ");
    return check("delivery queue", FAIL,
      `${notIngesting.length} target${notIngesting.length === 1 ? "" : "s"} not ingesting prompts: ${targets}`,
      "the pane accepts keystrokes but ingested nothing across consecutive receipt budgets; inspect the pane process, then have senders resend");
  }
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
