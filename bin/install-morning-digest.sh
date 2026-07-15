#!/usr/bin/env bash
# Installs the 08:00 morning-digest cron entry and REMOVES the standalone
# todo-remind entry (its content is folded into the digest: the morning must
# be exactly ONE push). Idempotent; refuses to install a dangling entry.
set -euo pipefail
SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/morning-digest-cron.sh"
if [ ! -x "$SCRIPT" ]; then
  echo "refusing to install: $SCRIPT missing or not executable" >&2
  exit 1
fi
ENTRY="0 8 * * * $SCRIPT >> \$HOME/.cache/agentmux-morning-digest-cron.log 2>&1 # amux-morning-digest"
current="$(crontab -l 2>/dev/null || true)"
cleaned="$(printf '%s\n' "$current" | grep -v "amux-morning-digest" | grep -v "todo-remind-cron.sh" || true)"
printf '%s\n%s\n' "$cleaned" "$ENTRY" | sed '/^$/d' | crontab -
echo "installed: $ENTRY"
echo "removed any standalone todo-remind entry (folded into the digest)"
