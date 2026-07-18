#!/usr/bin/env bash
# Install the bridge watchdog as a */5 crontab entry (idempotent).
set -euo pipefail

# Prefer the immutable package behind the active amux binary. An installer
# invoked from a feature worktree must never leave cron executing that
# disposable checkout after the release has moved on.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
if command -v amux >/dev/null 2>&1; then
  AMUX_REALPATH="$(readlink -f "$(command -v amux)" 2>/dev/null || true)"
  AMUX_PACKAGE="$(cd "$(dirname "$AMUX_REALPATH")/.." 2>/dev/null && pwd || true)"
  if [ -n "$AMUX_PACKAGE" ] && [ -f "$AMUX_PACKAGE/bin/bridge-watchdog-cron.sh" ]; then
    DIR="$AMUX_PACKAGE"
  fi
fi
printf -v WATCHDOG_PATH '%q' "$DIR/bin/bridge-watchdog-cron.sh"
ENTRY="* * * * * bash $WATCHDOG_PATH"

current=$(crontab -l 2>/dev/null || true)
installed=$(printf '%s\n' "$current" | grep -F "bridge-watchdog-cron.sh" || true)
if [ "$installed" = "$ENTRY" ]; then
  echo "watchdog already installed:"
  echo "$ENTRY"
  exit 0
fi
without_old=$(printf '%s\n' "$current" | grep -vF "bridge-watchdog-cron.sh" || true)
printf '%s\n%s\n' "$without_old" "$ENTRY" | sed '/^[[:space:]]*$/d' | crontab -
echo "installed: $ENTRY"
echo "kill-switch: touch ~/.agentmux/watchdog-OFF"
