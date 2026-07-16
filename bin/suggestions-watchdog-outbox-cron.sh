#!/usr/bin/env bash
# One overlap-locked all-project watchdog outbox drain.
set -euo pipefail

if [ -z "${HOME:-}" ]; then
  export HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
fi
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
LOG_PATH="${AMUX_WATCHDOG_OUTBOX_LOG:-$HOME/.agentmux/suggestions-watchdog-outbox.log}"
LOCK_PATH="${AMUX_WATCHDOG_OUTBOX_LOCK:-$HOME/.agentmux/suggestions-watchdog-outbox.lock}"

if [ -z "$NODE_BIN" ]; then
  printf "ERROR suggestions-watchdog-outbox: node executable not found\n" >&2
  exit 1
fi
if ! command -v flock >/dev/null 2>&1; then
  printf "ERROR suggestions-watchdog-outbox: flock executable not found\n" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_PATH")" "$(dirname "$LOCK_PATH")"
chmod 700 "$(dirname "$LOG_PATH")" "$(dirname "$LOCK_PATH")" 2>/dev/null || true
exec 9>"$LOCK_PATH"
if ! flock -n 9; then exit 0; fi

set +e
output="$("$NODE_BIN" "$SCRIPT_DIR/suggestions-watchdog-outbox.mjs" "$@" 2>&1)"
status=$?
set -e
if [ -n "$output" ]; then printf "%s %s\n" "$(date -Is)" "$output" >> "$LOG_PATH"; fi
if [ "$status" -ne 0 ]; then
  printf "%s ERROR exit=%s\n" "$(date -Is)" "$status" >> "$LOG_PATH"
  printf "%s\n" "$output" >&2
fi
exit "$status"
