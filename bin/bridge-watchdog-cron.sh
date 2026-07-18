#!/usr/bin/env bash
# Bridge watchdog: free shell cron (survives bridge death by design) that
# catches what the in-process supervisor (bin/start.sh) cannot:
#   - HUNG bridge: pid alive, heartbeat stale -> kill it (supervisor restarts)
#   - DEAD managed stack: no bridge AND no supervisor -> start detached
# Manual/stopped mode never auto-starts; the visible terminal stays user-owned.
#   - HUNG tmux server: three consecutive socket probes fail -> kill only the
#     identity-proven server and ask the replacement bridge to rebuild the fleet
# Rate-limited to 3 interventions/hour; every action is logged. The bridge
# heartbeat contract lives in core/heartbeat.mjs (30s beat, 5 min stale).
#
# Install: bash bin/install-bridge-watchdog.sh   (adds a once-per-minute cron entry)
# Kill-switch: touch ~/.agentmux/watchdog-OFF

set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$HOME/.agentmux"
MODE_FILE="${AMUX_BRIDGE_MODE_FILE:-$STATE_DIR/bridge-mode}"
LOG="$STATE_DIR/watchdog.log"
HEARTBEAT="$STATE_DIR/bridge-heartbeat.json"
QUOTA_HEARTBEAT="$STATE_DIR/quota-recovery-heartbeat.json"
INTERVENTIONS="$STATE_DIR/watchdog-interventions"
TMUX_SOCKET="${TMUX_SOCKET:-/tmp/openclaw-claude.sock}"
TMUX_FAILURES="$STATE_DIR/tmux-watchdog-failures"
FLEET_RESTART_REQUEST="${AMUX_FLEET_RESTART_REQUEST:-$STATE_DIR/fleet-restart-request.json}"
STALE_SEC=300
QUOTA_STALE_SEC=900
TMUX_PROBE_TIMEOUT_SEC=5
TMUX_FAILURE_THRESHOLD=3
MAX_PER_HOUR=3

mkdir -p "$STATE_DIR"
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

[ -f "$STATE_DIR/watchdog-OFF" ] && exit 0

# Only count bridges running from THIS repo (other projects have their own
# node [preload flags] index.mjs). [n] bracket keeps pgrep from matching our own shell.
bridge_pids() {
  for pid in $(pgrep -f '[n]ode( [^ ]+)* index\.mjs' 2>/dev/null); do
    [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$DIR" ] && echo "$pid"
  done
}
supervisor_alive() {
  for pid in $(pgrep -f '[s]tart.sh' 2>/dev/null); do
    [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$DIR" ] && return 0
  done
  return 1
}

rate_limited() {
  local now cutoff count
  now=$(date +%s); cutoff=$((now - 3600))
  [ -f "$INTERVENTIONS" ] || : > "$INTERVENTIONS"
  count=$(awk -v c="$cutoff" '$1 >= c' "$INTERVENTIONS" | wc -l)
  [ "$count" -ge "$MAX_PER_HOUR" ]
}
record_intervention() { date +%s >> "$INTERVENTIONS"; }

heartbeat_age() {
  [ -f "$HEARTBEAT" ] || { echo 999999; return; }
  local mtime now
  mtime=$(stat -c %Y "$HEARTBEAT" 2>/dev/null || echo 0)
  now=$(date +%s)
  echo $((now - mtime))
}

quota_heartbeat_age() {
  [ -f "$QUOTA_HEARTBEAT" ] || { echo 0; return; }
  local mtime now
  mtime=$(stat -c %Y "$QUOTA_HEARTBEAT" 2>/dev/null || echo 0)
  now=$(date +%s)
  echo $((now - mtime))
}

tmux_probe() {
  command -v tmux >/dev/null 2>&1 || return 0
  timeout "$TMUX_PROBE_TIMEOUT_SEC" tmux -S "$TMUX_SOCKET" display-message -p '#{pid}' >/dev/null 2>&1
}

# tmux clients share the same argv prefix as the server. The server is the
# session-leading process whose original command started/created the server;
# requiring uid + socket + session leadership prevents killing attach clients
# or another user's tmux instance.
tmux_server_pids() {
  ps -eo pid=,sid=,uid=,comm=,args= | awk -v uid="$(id -u)" -v socket="$TMUX_SOCKET" '
    $1 == $2 && $3 == uid && $4 == "tmux" {
      has_socket = 0; server_shape = 0
      for (i = 5; i <= NF; i++) {
        if ($i == "-S" && $(i + 1) == socket) has_socket = 1
        if ($i == "new-session" || $i == "start-server") server_shape = 1
      }
      if (has_socket && server_shape) print $1
    }'
}

write_fleet_restart_request() {
  local temp requested
  requested=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
  temp="$FLEET_RESTART_REQUEST.$$.tmp"
  printf '{"version":1,"source":"watchdog","requestedAt":"%s"}\n' "$requested" > "$temp"
  chmod 600 "$temp"
  mv "$temp" "$FLEET_RESTART_REQUEST"
}

PIDS=$(bridge_pids)
AGE=$(heartbeat_age)
QUOTA_AGE=$(quota_heartbeat_age)

if [ -n "$PIDS" ] && [ "$AGE" -gt "$STALE_SEC" ] && [ -f "$HEARTBEAT" ]; then
  # Hung: alive but not beating. Kill; the supervisor restarts with fresh code.
  if rate_limited; then log "HUNG bridge (beat ${AGE}s old) but rate-limited, skipping"; exit 0; fi
  log "HUNG bridge pid(s) $PIDS (beat ${AGE}s old) -> kill -9 (supervisor restarts)"
  record_intervention
  # SIGKILL is deliberate: TERM reads as clean stop (exit 143 -> supervisor
  # BREAKS), INT makes bash kill the supervisor itself (child-died-of-SIGINT
  # semantics, observed 2026-07-08). KILL -> exit 137 -> crash branch -> restart.
  for pid in $PIDS; do kill -9 "$pid" 2>/dev/null; done
  exit 0
fi

# The Discord/event loop can keep beating while the independent quota poll is
# wedged. A stale non-disabled sidecar is therefore its own restart condition.
if [ -n "$PIDS" ] && [ -f "$QUOTA_HEARTBEAT" ] \
  && ! grep -q '"state":"disabled"' "$QUOTA_HEARTBEAT" \
  && [ "$QUOTA_AGE" -gt "$QUOTA_STALE_SEC" ]; then
  if rate_limited; then log "STALE quota recovery (${QUOTA_AGE}s) but rate-limited, skipping"; exit 0; fi
  log "STALE quota recovery (${QUOTA_AGE}s) with live bridge pid(s) $PIDS -> kill -9 (supervisor restarts)"
  record_intervention
  for pid in $PIDS; do kill -9 "$pid" 2>/dev/null; done
  exit 0
fi

# A responsive bridge can continue heartbeating while every tmux operation is
# wedged. Treat one failed socket probe as suspicion, not proof. Three
# once-per-minute failures earn one whole-fleet restart from outside tmux.
if [ -S "$TMUX_SOCKET" ]; then
  if tmux_probe; then
    echo 0 > "$TMUX_FAILURES"
  else
    FAILURES=$(cat "$TMUX_FAILURES" 2>/dev/null || echo 0)
    case "$FAILURES" in (*[!0-9]*|'') FAILURES=0;; esac
    FAILURES=$((FAILURES + 1))
    echo "$FAILURES" > "$TMUX_FAILURES"
    if [ "$FAILURES" -lt "$TMUX_FAILURE_THRESHOLD" ]; then
      log "SUSPECT tmux socket $TMUX_SOCKET: probe $FAILURES/$TMUX_FAILURE_THRESHOLD failed"
      exit 0
    fi
    if rate_limited; then
      log "HUNG tmux socket after $FAILURES probes but rate-limited, skipping"
      exit 0
    fi
    TMUX_PIDS=$(tmux_server_pids)
    if [ -z "$TMUX_PIDS" ]; then
      log "HUNG tmux socket after $FAILURES probes, but no identity-proven server pid; refusing broad kill"
      exit 0
    fi
    log "HUNG tmux server pid(s) $TMUX_PIDS after $FAILURES probes -> exact server kill + fleet rebuild"
    record_intervention
    for pid in $TMUX_PIDS; do kill -9 "$pid" 2>/dev/null; done
    sleep 1
    [ -S "$TMUX_SOCKET" ] && unlink "$TMUX_SOCKET" 2>/dev/null
    write_fleet_restart_request
    echo 0 > "$TMUX_FAILURES"
    # The supervised bridge consumes the request before its watchers start.
    # SIGUSR2 maps to start.sh's clean restart code 75.
    if [ -n "$PIDS" ]; then
      for pid in $PIDS; do kill -USR2 "$pid" 2>/dev/null; done
    fi
    exit 0
  fi
else
  echo 0 > "$TMUX_FAILURES"
fi

if [ -z "$PIDS" ] && ! supervisor_alive; then
  # Manual is the default even without a mode file. Dead-stack autostart is
  # available only after an explicit `amux serve --detach` wrote managed.
  MODE=$(cat "$MODE_FILE" 2>/dev/null || echo manual)
  [ "$MODE" = "managed" ] || exit 0
  # Whole stack dead. Start detached; start.sh supervises from here on. The
  # watchdog is itself the trusted launcher in this recovery path, so it does
  # not need the CLI's interactive ownership receipt.
  if rate_limited; then log "bridge+supervisor DEAD but rate-limited, skipping"; exit 0; fi
  log "bridge+supervisor dead -> starting bin/start.sh detached"
  record_intervention
  cd "$DIR" && nohup bash bin/start.sh >> "$STATE_DIR/bridge.log" 2>&1 &
  exit 0
fi

exit 0
