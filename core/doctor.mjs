// amux doctor: surface the SILENT failure modes in one table. Every check
// answers a question that otherwise fails invisibly:
//   - is the bridge process alive, and supervised (bin/start.sh)?
//   - is its event loop actually beating (hung vs healthy)?
//   - is it running the repo's CURRENT code (the stale-bridge trap)?
//   - are the Claude Code hooks installed and their script present?
//   - is the event ledger alive and rotating?
//   - does tmux answer on the amux socket?
//
// Pure functions + injected I/O so every rule is unit-testable; the CLI
// wrapper (cmdDoctor) does the real reads.

import { classifyHeartbeat } from "./heartbeat.mjs";

export const OK = "ok";
export const WARN = "warn";
export const FAIL = "fail";

const check = (name, status, detail, hint = "") => ({ name, status, detail, hint });

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
        "event loop is stuck: kill the pid (supervisor restarts it)");
    case "dead":
      return check("bridge heartbeat", FAIL, "stale beat and no live pid",
        "start it: amux serve");
    default:
      return check("bridge heartbeat", WARN, "no heartbeat file",
        "bridge predates heartbeat support: restart it once");
  }
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
  return check("claude hooks", OK, `installed (${entries.join(", ")})`);
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

export function checkTmux({ sessions, error }) {
  if (error) {
    return check("tmux", FAIL, `socket not answering: ${error}`,
      "agents unreachable; is tmux running on the amux socket?");
  }
  return check("tmux", OK, `${sessions.length} session${sessions.length === 1 ? "" : "s"} (${sessions.join(", ")})`);
}

export function checkConfig({ agents, error }) {
  if (error) {
    return check("config", FAIL, `agentmux.yaml unparseable: ${error}`, "amux edit");
  }
  return check("config", OK, `${agents.length} agents configured`);
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
