#!/usr/bin/env bash
# Install/remove the 10-minute Android emulator idle sweep.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$DIR/bin/android-emulator-guard-cron.sh"
ACTION="${1:-install}"
TAG="amux-android-emulator-guard"

current="$(crontab -l 2>/dev/null || true)"
without_old="$(printf '%s\n' "$current" | grep -vF "$TAG" || true)"
if [ "$ACTION" = "remove" ] || [ "$ACTION" = "uninstall" ]; then
  printf '%s\n' "$without_old" | sed '/^[[:space:]]*$/d' | crontab -
  echo "removed Android emulator guard cron; state and logs retained"
  exit 0
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "refusing to install: resolved node executable is unavailable" >&2
  exit 1
fi
if [ ! -x "$SCRIPT" ]; then
  echo "refusing to install: $SCRIPT is missing or not executable" >&2
  exit 1
fi
printf -v ENTRY '*/10 * * * * NODE_BIN=%q AMUX_ANDROID_EMULATOR_IDLE_MINUTES=60 AMUX_ANDROID_EMULATOR_CONFIRM_MINUTES=5 %q >/dev/null 2>&1 # %s' \
  "$NODE_BIN" "$SCRIPT" "$TAG"
printf '%s\n%s\n' "$without_old" "$ENTRY" | sed '/^[[:space:]]*$/d' | crontab -
echo "installed: $ENTRY"
echo "headless emulators are gracefully stopped after 60m idle and two observations"
