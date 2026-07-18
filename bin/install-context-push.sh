#!/usr/bin/env bash
# Install the Suggestions context push as a per-minute crontab entry.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$DIR/bin/suggestions-context-push-cron.sh"
ACTION="${1:-install}"
if [ "$ACTION" = "remove" ] || [ "$ACTION" = "uninstall" ]; then
  current=$(crontab -l 2>/dev/null || true)
  without_old=$(printf '%s\n' "$current" | grep -vF "suggestions-context-push-cron.sh" || true)
  if [ "$current" = "$without_old" ]; then
    echo "context push NOT INSTALLED. Nothing to remove."
    exit 0
  fi
  printf '%s\n' "$without_old" | sed '/^[[:space:]]*$/d' | crontab -
  echo "removed Suggestions context push cron entry; config and state retained."
  exit 0
fi
CONFIG="${1:-$HOME/.config/agent/suggestions-quota-push.yaml}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "refusing to install: resolved node executable is unavailable" >&2
  exit 1
fi
printf -v ENTRY '* * * * * NODE_BIN=%q %q %q >/dev/null' \
  "$NODE_BIN" "$SCRIPT" "$CONFIG"

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
  echo "context push already installed:"
  printf '%s\n' "$ENTRY"
  exit 0
fi
without_old=$(printf '%s\n' "$current" | grep -vF "suggestions-context-push-cron.sh" || true)
printf '%s\n%s\n' "$without_old" "$ENTRY" | sed '/^[[:space:]]*$/d' | crontab -
echo "installed or updated: $ENTRY"
echo "log: ~/.agentmux/suggestions-context-push.log"
