#!/usr/bin/env bash
# Install the bridge watchdog as a */5 crontab entry (idempotent).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="*/5 * * * * bash $DIR/bin/bridge-watchdog-cron.sh"

current=$(crontab -l 2>/dev/null || true)
if echo "$current" | grep -qF "bridge-watchdog-cron.sh"; then
  echo "watchdog already installed:"
  echo "$current" | grep -F "bridge-watchdog-cron.sh"
  exit 0
fi
printf '%s\n%s\n' "$current" "$ENTRY" | crontab -
echo "installed: $ENTRY"
echo "kill-switch: touch ~/.agentmux/watchdog-OFF"
