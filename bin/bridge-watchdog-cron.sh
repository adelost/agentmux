#!/usr/bin/env bash
# Bridge watchdog: free shell cron (survives bridge death by design) that
# catches what the in-process supervisor (bin/start.sh) cannot:
#   - HUNG bridge: pid alive, heartbeat stale -> kill it (supervisor restarts)
#   - DEAD stack: no bridge AND no supervisor -> start amux serve detached
# Rate-limited to 3 interventions/hour; every action is logged. The
# heartbeat contract lives in core/heartbeat.mjs (30s beat, 5 min stale).
#
# Install: bash bin/install-bridge-watchdog.sh   (adds a */5 crontab entry)
# Kill-switch: touch ~/.agentmux/watchdog-OFF

set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$HOME/.agentmux"
LOG="$STATE_DIR/watchdog.log"
HEARTBEAT="$STATE_DIR/bridge-heartbeat.json"
INTERVENTIONS="$STATE_DIR/watchdog-interventions"
STALE_SEC=300
MAX_PER_HOUR=3

mkdir -p "$STATE_DIR"
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

[ -f "$STATE_DIR/watchdog-OFF" ] && exit 0

# Only count bridges running from THIS repo (other projects have their own
# node index.mjs). [n] bracket keeps pgrep from matching our own shell.
bridge_pids() {
  for pid in $(pgrep -f '[n]ode index.mjs' 2>/dev/null); do
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

PIDS=$(bridge_pids)
AGE=$(heartbeat_age)

if [ -n "$PIDS" ] && [ "$AGE" -gt "$STALE_SEC" ] && [ -f "$HEARTBEAT" ]; then
  # Hung: alive but not beating. Kill; the supervisor restarts with fresh code.
  if rate_limited; then log "HUNG bridge (beat ${AGE}s old) but rate-limited, skipping"; exit 0; fi
  log "HUNG bridge pid(s) $PIDS (beat ${AGE}s old) -> kill (supervisor restarts)"
  record_intervention
  kill $PIDS 2>/dev/null
  exit 0
fi

if [ -z "$PIDS" ] && ! supervisor_alive; then
  # Whole stack dead. Start detached; start.sh supervises from here on.
  if rate_limited; then log "bridge+supervisor DEAD but rate-limited, skipping"; exit 0; fi
  log "bridge+supervisor dead -> starting bin/start.sh detached"
  record_intervention
  cd "$DIR" && nohup bash bin/start.sh >> "$STATE_DIR/bridge.log" 2>&1 &
  exit 0
fi

exit 0
