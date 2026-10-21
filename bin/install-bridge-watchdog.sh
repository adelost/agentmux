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
# Cron has no interactive nvm PATH; both node and the CLI's env-node shebang need it.
NODE_BIN="${NODE_BIN:-$(command -v node)}"
AMUX="${AMUX:-$(command -v amux)}"
[ -x "$NODE_BIN" ] && [ -x "$AMUX" ] || { echo "watchdog requires an installed node and amux" >&2; exit 1; }
printf -v WATCHDOG_NODE '%q' "$NODE_BIN"
printf -v WATCHDOG_AMUX '%q' "$AMUX"
printf -v WATCHDOG_ENV_PATH '%q' "$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin"
ENTRY="* * * * * PATH=$WATCHDOG_ENV_PATH NODE_BIN=$WATCHDOG_NODE AMUX=$WATCHDOG_AMUX bash $WATCHDOG_PATH"

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
