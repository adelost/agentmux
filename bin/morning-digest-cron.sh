#!/usr/bin/env bash
# Cron wrapper for `amux morning-digest`. Intended for crontab at 08:00 daily.
#
# ONE morning DM with everything waiting on the HUMAN: remindable todos
# (folded in from todo-remind, which this cron REPLACES in crontab), board
# tickets in needs_detail, and open human-directed asks from panes. Silent
# when the queue is empty; board read-failures page loudly inside the digest
# instead of reading as an empty queue.
#
# Install via: bin/install-morning-digest.sh
set -euo pipefail

if [ -z "${HOME:-}" ]; then
  export HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
fi
export PATH="/usr/bin:/bin:${PATH:-}"

AGENTMUX_DIR="${AGENTMUX_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v22.19.0/bin/node}"
MORNING_DIGEST_LOG="${MORNING_DIGEST_LOG:-$HOME/.cache/agentmux-morning-digest.log}"
mkdir -p "$(dirname "$MORNING_DIGEST_LOG")"

notify_failure() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    "$NODE_BIN" "$AGENTMUX_DIR/bin/agent-cli.mjs" notifyuser \
      --level error \
      --title "amux morning-digest" \
      "Morgondigesten failade med exit $status. Se $MORNING_DIGEST_LOG" || true
  fi
}
trap notify_failure EXIT

output="$("$NODE_BIN" "$AGENTMUX_DIR/bin/agent-cli.mjs" morning-digest 2>&1)" || {
  status=$?
  printf "%s\n" "$output" >> "$MORNING_DIGEST_LOG"
  exit "$status"
}
printf "%s OK %s\n" "$(date -Is)" "$output" >> "$MORNING_DIGEST_LOG"
