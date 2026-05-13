#!/usr/bin/env bash
set -euo pipefail

if [ -z "${HOME:-}" ]; then
  export HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
fi
export PATH="/usr/bin:/bin:${PATH:-}"
export TMUX_SOCKET="${TMUX_SOCKET:-/tmp/openclaw-claude.sock}"
export AGENT_CONFIG="${AGENT_CONFIG:-$HOME/.config/agent/agents.yaml}"

AGENTMUX_DIR="${AGENTMUX_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v22.19.0/bin/node}"
OPENCLAW_WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
AGENTMUX_DREAM_LOG="${AGENTMUX_DREAM_LOG:-$HOME/agentmux-dream.log}"

notify_failure() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    "$NODE_BIN" "$AGENTMUX_DIR/bin/agent-cli.mjs" notifyuser \
      --level error \
      --title "amux dream" \
      "Nightly dream failed with exit $status. Check $AGENTMUX_DREAM_LOG" || true
  fi
}
trap notify_failure EXIT

dream_output="$("$NODE_BIN" "$AGENTMUX_DIR/bin/agent-cli.mjs" dream --quiet 2>&1)" || {
  status=$?
  printf "%s\n" "$dream_output" >&2
  exit "$status"
}
if [ -n "$dream_output" ]; then
  printf "%s\n" "$dream_output" >> "$AGENTMUX_DREAM_LOG"
fi
if printf "%s\n" "$dream_output" | grep -q "^Dream skipped: lock-held"; then
  printf "%s OK amux dream skipped; another run holds the lock\n" "$(date -Is)" >> "$AGENTMUX_DREAM_LOG"
  exit 0
fi

date_key="$(TZ=Europe/Stockholm date +%F)"
daily_file="$OPENCLAW_WORKSPACE/memory/$date_key.md"

test -s "$daily_file"
grep -q "<!-- template: daily -->" "$daily_file"
grep -q "^> summary:" "$daily_file"
grep -q "^> why:" "$daily_file"
grep -q "<!-- amux-dream-run:$date_key " "$daily_file"

printf "%s OK amux dream %s\n" "$(date -Is)" "$daily_file" >> "$AGENTMUX_DREAM_LOG"
