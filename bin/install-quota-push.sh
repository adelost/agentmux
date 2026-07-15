#!/usr/bin/env bash
# Install the Suggestions quota push as a 15-minute crontab entry (idempotent).
# Refuses to install a dangling entry: script and config must exist first
# (same guard class as install-board-curator.sh, PR #16 review).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$DIR/bin/suggestions-quota-push-cron.sh"
CONFIG="${1:-$HOME/.config/agent/suggestions-quota-push.yaml}"
ENTRY="*/15 * * * * $SCRIPT >> /dev/null 2>&1"

if [ ! -x "$SCRIPT" ]; then
  echo "refusing to install: $SCRIPT is missing or not executable" >&2
  exit 1
fi
if [ ! -f "$CONFIG" ]; then
  echo "refusing to install: config $CONFIG is missing" >&2
  echo "(copy suggestions-quota-push.yaml.example and point adminCredentialFile at the admin token)" >&2
  exit 1
fi

current=$(crontab -l 2>/dev/null || true)
if echo "$current" | grep -qF "suggestions-quota-push-cron.sh"; then
  echo "quota push already installed:"
  echo "$current" | grep -F "suggestions-quota-push-cron.sh"
  exit 0
fi
printf '%s\n%s\n' "$current" "$ENTRY" | crontab -
echo "installed: $ENTRY"
echo "log: ~/.agentmux/suggestions-quota-push.log"
