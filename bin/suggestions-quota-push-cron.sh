#!/usr/bin/env bash
# One overlap-locked quota-snapshot push to the Suggestions board.
set -euo pipefail

if [ -z "${HOME:-}" ]; then
  export HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
fi
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
LOG_PATH="${AMUX_QUOTA_PUSH_LOG:-$HOME/.agentmux/suggestions-quota-push.log}"
LOCK_PATH="${AMUX_QUOTA_PUSH_LOCK:-$HOME/.agentmux/suggestions-quota-push.lock}"
STATE_PATH="${AMUX_QUOTA_PUSH_STATE:-$HOME/.agentmux/suggestions-quota-push-events.jsonl}"

mkdir -p "$(dirname "$LOG_PATH")" "$(dirname "$LOCK_PATH")" "$(dirname "$STATE_PATH")"
chmod 700 "$(dirname "$LOG_PATH")" "$(dirname "$LOCK_PATH")" "$(dirname "$STATE_PATH")" 2>/dev/null || true
export AMUX_QUOTA_PUSH_STATE="$STATE_PATH"

record_event() {
  local outcome="$1" reason="${2:-}"
  local at
  at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
  if [ -n "$reason" ]; then
    printf '{"version":1,"at":"%s","outcome":"%s","reason":"%s"}\n' \
      "$at" "$outcome" "$reason" >> "$STATE_PATH"
  else
    printf '{"version":1,"at":"%s","outcome":"%s"}\n' \
      "$at" "$outcome" >> "$STATE_PATH"
  fi
  chmod 600 "$STATE_PATH" 2>/dev/null || true
  sync -d "$STATE_PATH" 2>/dev/null || true
}

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  record_event failure node_unavailable
  printf "ERROR suggestions-quota-push: node executable not found\n" >&2
  exit 1
fi
if ! command -v flock >/dev/null 2>&1; then
  record_event failure flock_unavailable
  printf "ERROR suggestions-quota-push: flock executable not found\n" >&2
  exit 1
fi

exec 9>"$LOCK_PATH"
if ! flock -n 9; then
  set +e
  output="$(timeout 10 "$NODE_BIN" "$SCRIPT_DIR/suggestions-quota-push.mjs" \
    --record-lock-skip "$STATE_PATH" 2>&1)"
  status=$?
  set -e
  if [ -n "$output" ]; then printf "%s %s\n" "$(date -Is)" "$output" >> "$LOG_PATH"; fi
  if [ "$status" -ne 0 ]; then printf "%s\n" "$output" >&2; fi
  exit "$status"
fi

set +e
output="$(timeout 60 "$NODE_BIN" "$SCRIPT_DIR/suggestions-quota-push.mjs" "$@" 2>&1)"
status=$?
set -e
if [ -n "$output" ]; then printf "%s %s\n" "$(date -Is)" "$output" >> "$LOG_PATH"; fi
if [ "$status" -ne 0 ]; then
  record_event failure "process_exit_${status}"
  printf "%s ERROR exit=%s\n" "$(date -Is)" "$status" >> "$LOG_PATH"
  printf "%s\n" "$output" >&2
fi
exit "$status"
