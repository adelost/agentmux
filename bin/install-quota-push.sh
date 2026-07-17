#!/usr/bin/env bash
# Install the Suggestions quota push as a 15-minute crontab entry (idempotent).
# Refuses to install a dangling entry: script and config must exist first
# (same guard class as install-board-curator.sh, PR #16 review).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$DIR/bin/suggestions-quota-push-cron.sh"
CONFIG="${1:-$HOME/.config/agent/suggestions-quota-push.yaml}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
STATE_PATH="${AMUX_QUOTA_PUSH_STATE:-$HOME/.agentmux/suggestions-quota-push-events.jsonl}"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "refusing to install: resolved node executable is unavailable" >&2
  exit 1
fi
printf -v ENTRY '*/15 * * * * NODE_BIN=%q AMUX_QUOTA_PUSH_STATE=%q %q %q >/dev/null' \
  "$NODE_BIN" "$STATE_PATH" "$SCRIPT" "$CONFIG"

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
if printf '%s\n' "$current" | grep -Fxq -- "$ENTRY"; then
  echo "quota push already installed:"
  printf '%s\n' "$ENTRY"
  exit 0
fi
without_old=$(printf '%s\n' "$current" | grep -vF "suggestions-quota-push-cron.sh" || true)
printf '%s\n%s\n' "$without_old" "$ENTRY" | sed '/^[[:space:]]*$/d' | crontab -
echo "installed or updated: $ENTRY"
echo "log: ~/.agentmux/suggestions-quota-push.log"
