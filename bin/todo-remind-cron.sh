#!/usr/bin/env bash
# Cron wrapper for `amux todo-remind`. Intended for crontab at 08:00 daily.
#
# Reads ~/.openclaw/workspace/memory/tasks.md and sends a push notification
# via notifyuser if any active todos exist. Silent if list is empty.
#
# Sample crontab entry:
#   0 8 * * * /home/adelost/lsrc/agentmux/bin/todo-remind-cron.sh
#
# Install via: bin/install-todo-cron.sh
set -euo pipefail

if [ -z "${HOME:-}" ]; then
  export HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
fi
export PATH="/usr/bin:/bin:${PATH:-}"

AGENTMUX_DIR="${AGENTMUX_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v22.19.0/bin/node}"
TODO_REMIND_LOG="${TODO_REMIND_LOG:-$HOME/agentmux-todo-remind.log}"
TODOS_PATH="${AMUX_TODOS_PATH:-$HOME/.openclaw/workspace/memory/tasks.md}"

notify_failure() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    "$NODE_BIN" "$AGENTMUX_DIR/bin/agent-cli.mjs" notifyuser \
      --level error \
      --title "amux todo-remind" \
      "Daily todo reminder failed with exit $status. Check $TODO_REMIND_LOG" || true
  fi
}
trap notify_failure EXIT

# Skip silently if tasks file doesn't exist yet (first-time user).
if [ ! -f "$TODOS_PATH" ]; then
  printf "%s SKIP no tasks file at %s\n" "$(date -Is)" "$TODOS_PATH" >> "$TODO_REMIND_LOG"
  exit 0
fi

remind_output="$(AMUX_TODOS_PATH="$TODOS_PATH" "$NODE_BIN" "$AGENTMUX_DIR/bin/agent-cli.mjs" todo-remind 2>&1)" || {
  status=$?
  printf "%s\n" "$remind_output" >&2
  exit "$status"
}

printf "%s OK %s\n" "$(date -Is)" "$remind_output" >> "$TODO_REMIND_LOG"
