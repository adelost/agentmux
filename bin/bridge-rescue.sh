#!/usr/bin/env bash
# Out-of-band bridge recovery used by the Windows Discord restarter.
# It never trusts a pidfile alone: every signal is bound to the expected
# uid, command shape, cwd, and (for the supervisor) process group.

set -u

STATE_DIR="${AMUX_STATE_DIR:-$HOME/.agentmux}"
PIDFILE="${PIDFILE:-/tmp/agentmux.pid}"
READY_FILE="${READY_FILE:-/tmp/agentmux.ready}"
SERVICE_RECORD="${AMUX_BRIDGE_SERVICE_RECORD:-$STATE_DIR/bridge-service/process.json}"
AMUX_BIN="${AMUX_BIN:-$(command -v amux 2>/dev/null || true)}"

log() { printf '%s\n' "$*"; }

numeric_pid() {
  local value="${1:-}"
  case "$value" in
    ''|*[!0-9]*) return 1 ;;
    *) [ "$value" -gt 1 ] 2>/dev/null ;;
  esac
}

read_pidfile() {
  local value
  [ -r "$PIDFILE" ] || return 1
  value="$(tr -d '[:space:]' < "$PIDFILE")"
  numeric_pid "$value" || return 1
  printf '%s\n' "$value"
}

same_uid() {
  local pid="$1" process_uid
  process_uid="$(awk '/^Uid:/ { print $2; exit }' "/proc/$pid/status" 2>/dev/null || true)"
  [ "$process_uid" = "$(id -u)" ]
}

bridge_owned() {
  local pid="$1" cwd command
  numeric_pid "$pid" || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  same_uid "$pid" || return 1
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  command="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  case "$cwd" in
    */agentmux|*/agentmux\ \(deleted\)) ;;
    *) return 1 ;;
  esac
  case "$command" in
    *node*index.mjs*) return 0 ;;
    *) return 1 ;;
  esac
}

ready_pid() {
  local pid ready
  pid="$(read_pidfile)" || return 1
  [ -r "$READY_FILE" ] || return 1
  ready="$(tr -d '[:space:]' < "$READY_FILE")"
  [ "$pid" = "$ready" ] || return 1
  bridge_owned "$pid" || return 1
  printf '%s\n' "$pid"
}

wait_for_replacement() {
  local previous="${1:-}" timeout="${2:-25}" deadline current
  deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    current="$(ready_pid 2>/dev/null || true)"
    if [ -n "$current" ] && { [ -z "$previous" ] || [ "$current" != "$previous" ]; }; then
      printf '%s\n' "$current"
      return 0
    fi
    sleep 1
  done
  return 1
}

service_value() {
  local key="$1"
  [ -r "$SERVICE_RECORD" ] || return 1
  sed -n "s/^[[:space:]]*\"$key\":[[:space:]]*\\(\"\\{0,1\\}\\)\\([^\",]*\\)\\1[,[:space:]]*$/\\2/p" \
    "$SERVICE_RECORD" | head -n 1
}

supervisor_owned() {
  local pid="$1" expected_id="$2" cwd command pgid environment
  numeric_pid "$pid" || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  same_uid "$pid" || return 1
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  command="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  environment="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null || true)"
  case "$cwd" in
    */agentmux|*/agentmux\ \(deleted\)) ;;
    *) return 1 ;;
  esac
  [ "$pgid" = "$pid" ] || return 1
  case "$command" in
    *bash*bin/start.sh*) ;;
    *) return 1 ;;
  esac
  printf '%s\n' "$environment" | grep -Fqx "AMUX_BRIDGE_SUPERVISOR_ID=$expected_id"
}

start_managed() {
  if [ -z "$AMUX_BIN" ] || [ ! -x "$AMUX_BIN" ]; then
    log "RESCUE_FAILED stage=start reason=amux-not-found"
    return 1
  fi
  "$AMUX_BIN" serve --detach >/dev/null 2>&1 || true
  local current
  current="$(wait_for_replacement "" 35 2>/dev/null || true)"
  [ -n "$current" ] || return 1
  log "RESCUE_OK stage=managed-start pid=$current"
}

old_pid="$(read_pidfile 2>/dev/null || true)"

# Stage 1: ask the live bridge to perform its normal exact restart.
if [ -n "$old_pid" ] && bridge_owned "$old_pid"; then
  kill -USR2 "$old_pid" 2>/dev/null || true
  replacement="$(wait_for_replacement "$old_pid" 15 2>/dev/null || true)"
  if [ -n "$replacement" ]; then
    log "RESCUE_OK stage=signal old=$old_pid pid=$replacement"
    exit 0
  fi
fi

# Stage 2: a wedged Node event loop cannot consume SIGUSR2. SIGKILL makes
# start.sh take its crash branch; TERM would intentionally stop the stack.
stuck_pid="$(read_pidfile 2>/dev/null || true)"
if [ -n "$stuck_pid" ] && bridge_owned "$stuck_pid"; then
  kill -KILL "$stuck_pid" 2>/dev/null || true
  replacement="$(wait_for_replacement "$stuck_pid" 25 2>/dev/null || true)"
  if [ -n "$replacement" ]; then
    log "RESCUE_OK stage=bridge-kill old=$stuck_pid pid=$replacement"
    exit 0
  fi
fi

# Stage 3: if start.sh itself is wedged, stop only its identity-proven process
# group. The CLI then creates a fresh tmux-free managed supervisor.
supervisor_pid="$(service_value pid 2>/dev/null || true)"
supervisor_id="$(service_value serviceId 2>/dev/null || true)"
if [ -n "$supervisor_pid" ] && [ -n "$supervisor_id" ] \
    && supervisor_owned "$supervisor_pid" "$supervisor_id"; then
  kill -TERM -- "-$supervisor_pid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    kill -0 "$supervisor_pid" 2>/dev/null || break
    sleep 1
  done
  if supervisor_owned "$supervisor_pid" "$supervisor_id"; then
    kill -KILL -- "-$supervisor_pid" 2>/dev/null || true
    sleep 1
  fi
fi

if start_managed; then
  exit 0
fi

log "RESCUE_FAILED stage=managed-start reason=bridge-not-ready"
exit 1
