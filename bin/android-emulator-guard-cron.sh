#!/usr/bin/env bash
# Reap agent-owned headless Android emulators after bounded inactivity.
set -euo pipefail

if [ -z "${HOME:-}" ]; then
  export HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
IDLE_MINUTES="${AMUX_ANDROID_EMULATOR_IDLE_MINUTES:-60}"
CONFIRM_MINUTES="${AMUX_ANDROID_EMULATOR_CONFIRM_MINUTES:-5}"
STATE_DIR="$HOME/.agentmux"
LOG_PATH="${AMUX_ANDROID_EMULATOR_LOG:-$STATE_DIR/android-emulator-guard.log}"
LOCK_PATH="${AMUX_ANDROID_EMULATOR_LOCK:-$STATE_DIR/android-emulator-guard.lock}"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  printf '%s ERROR node executable unavailable\n' "$(date -Is)" >> "$LOG_PATH"
  exit 1
fi
exec 9>"$LOCK_PATH"
flock -n 9 || exit 0

set +e
output="$(timeout 45 "$NODE_BIN" "$SCRIPT_DIR/agent-cli.mjs" emulator reap \
  --minutes "$IDLE_MINUTES" --confirm-minutes "$CONFIRM_MINUTES" 2>&1)"
status=$?
set -e
printf '%s %s\n' "$(date -Is)" "$output" >> "$LOG_PATH"
if [ "$status" -ne 0 ]; then
  printf '%s\n' "$output" >&2
fi
exit "$status"
