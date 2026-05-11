#!/usr/bin/env bash
set -euo pipefail

export HOME="${HOME:-/home/adelost}"
export PATH="/usr/bin:/bin:${PATH:-}"
export TMUX_SOCKET="${TMUX_SOCKET:-/tmp/openclaw-claude.sock}"
export AGENT_CONFIG="${AGENT_CONFIG:-$HOME/.config/agent/agents.yaml}"

AGENTMUX_DIR="${AGENTMUX_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v22.19.0/bin/node}"
OPENCLAW_WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
AGENTMUX_DREAM_LOG="${AGENTMUX_DREAM_LOG:-$HOME/agentmux-dream.log}"
AGENTMUX_DREAM_MIN_TURNS="${AGENTMUX_DREAM_MIN_TURNS:-0}"

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

"$NODE_BIN" "$AGENTMUX_DIR/bin/agent-cli.mjs" dream --quiet --min-turns "$AGENTMUX_DREAM_MIN_TURNS"

date_key="$(TZ=Europe/Stockholm date +%F)"
daily_file="$OPENCLAW_WORKSPACE/memory/$date_key.md"

test -s "$daily_file"
grep -q "<!-- template: daily -->" "$daily_file"
grep -q "^> summary:" "$daily_file"
grep -q "^> why:" "$daily_file"
grep -q "<!-- amux-dream:$date_key -->" "$daily_file"
grep -q "<!-- /amux-dream:$date_key -->" "$daily_file"

printf "%s OK amux dream %s\n" "$(date -Is)" "$daily_file" >> "$AGENTMUX_DREAM_LOG"
