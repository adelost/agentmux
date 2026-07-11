#!/usr/bin/env bash
set -euo pipefail

if [ -z "${HOME:-}" ]; then
  HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
  export HOME
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

run_dream_pass() {
  local output status=0
  output="$("$NODE_BIN" "$AGENTMUX_DIR/bin/agent-cli.mjs" dream --quiet --workspace "$OPENCLAW_WORKSPACE" "$@" 2>&1)" || status=$?
  [ -n "$output" ] && printf "%s\n" "$output" >> "$AGENTMUX_DREAM_LOG"
  printf "%s" "$status"
}

# Pass 1 deliberately leaves the sentinel open. Panes busy at 04:00 get a
# second chance around 05:00; the process sleeps, but no dream lock is held.
first_status="$(run_dream_pass --defer-sentinel)"
if [ "$first_status" -ne 0 ]; then
  printf "%s WARN first dream pass exit=%s; retry will handle pane-local misses\n" "$(date -Is)" "$first_status" >> "$AGENTMUX_DREAM_LOG"
fi

if [ "${AMUX_DREAM_RETRY_ENABLED:-true}" != "false" ]; then
  retry_delay="${AMUX_DREAM_RETRY_DELAY_SECONDS:-3600}"
  if ! [[ "$retry_delay" =~ ^[0-9]+$ ]]; then
    echo "AMUX_DREAM_RETRY_DELAY_SECONDS must be a non-negative integer" >&2
    exit 2
  fi
  sleep "$retry_delay"
fi

dream_status=0
dream_output="$("$NODE_BIN" "$AGENTMUX_DIR/bin/agent-cli.mjs" dream --quiet --workspace "$OPENCLAW_WORKSPACE" --retry 2>&1)" || dream_status=$?
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

if [ "$dream_status" -ne 0 ]; then
  printf "%s WARN retry dream pass exit=%s; sentinel records pending panes\n" "$(date -Is)" "$dream_status" >> "$AGENTMUX_DREAM_LOG"
fi

# Actor chain: bank+compact bounded daily backlog, then lint and route the
# remaining count into today's file. Lint exit 1 means findings, not failure.
compact_status=0
compact_output="$("$NODE_BIN" "$AGENTMUX_DIR/bin/agent-cli.mjs" memory compact --json --workspace "$OPENCLAW_WORKSPACE" 2>&1)" || compact_status=$?
printf "%s\n" "$compact_output" >> "$AGENTMUX_DREAM_LOG"
if ! compacted="$(printf "%s" "$compact_output" | "$NODE_BIN" -e '
  let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{try{const r=JSON.parse(s); process.stdout.write(String(r.compacted?.length||0));}catch{process.exit(1)}})
')"; then
  echo "memory compact returned invalid JSON" >&2
  exit 2
fi

lint_status=0
lint_output="$("$NODE_BIN" "$AGENTMUX_DIR/bin/agent-cli.mjs" memory lint --json --report-daily --compacted "$compacted" --workspace "$OPENCLAW_WORKSPACE" 2>&1)" || lint_status=$?
printf "%s\n" "$lint_output" >> "$AGENTMUX_DREAM_LOG"
if ! printf "%s" "$lint_output" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{JSON.parse(s)}catch{process.exit(1)}})'; then
  echo "memory lint returned invalid JSON" >&2
  exit 2
fi
grep -q "<!-- amux-memory-status:$date_key -->" "$daily_file"

if [ "$compact_status" -ne 0 ]; then
  printf "%s ERROR memory compact exit=%s\n" "$(date -Is)" "$compact_status" >> "$AGENTMUX_DREAM_LOG"
  exit "$compact_status"
fi
# lint exit 1 is its documented "warnings found" contract. Any other nonzero
# means the linter itself failed and should trigger the cron failure push.
if [ "$lint_status" -gt 1 ]; then
  exit "$lint_status"
fi

printf "%s OK amux dream %s\n" "$(date -Is)" "$daily_file" >> "$AGENTMUX_DREAM_LOG"

# Search-index refresh: incremental (mtime), so the nightly cost is just the
# day's changed memory files. Failure is non-fatal — search degrades to
# lexical-only, and the next night catches up.
"$NODE_BIN" "$AGENTMUX_DIR/bin/agent-cli.mjs" search --reindex \
  >> "$AGENTMUX_DREAM_LOG" 2>&1 \
  || printf "%s WARN search reindex failed (lexical-only until next run)\n" "$(date -Is)" >> "$AGENTMUX_DREAM_LOG"
