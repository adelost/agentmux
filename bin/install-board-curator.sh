#!/usr/bin/env bash
# Install the board-curator as an hourly crontab entry (idempotent).
# Refuses to install a dangling entry: the target script must exist and be
# executable at install time (PR #16 review: the first install pointed cron
# at a script that only existed on a feature branch → hourly ENOENT noise).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$DIR/bin/board-curator-cron.sh"
ENTRY="7 * * * * $SCRIPT >> \$HOME/.cache/board-curator.log 2>&1"

if [ ! -x "$SCRIPT" ]; then
  echo "refusing to install: $SCRIPT is missing or not executable" >&2
  echo "(is this checkout on a branch/commit that contains the curator?)" >&2
  exit 1
fi

current=$(crontab -l 2>/dev/null || true)
if echo "$current" | grep -qF "board-curator-cron.sh"; then
  echo "board-curator already installed:"
  echo "$current" | grep -F "board-curator-cron.sh"
  exit 0
fi
printf '%s\n%s\n' "$current" "$ENTRY" | crontab -
echo "installed: $ENTRY"
echo "off-switch: touch ~/.agentmux/fleet-watch/OFF (global) or <session>.OFF (per fleet)"
