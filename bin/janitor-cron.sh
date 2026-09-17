#!/usr/bin/env bash
# janitor-cron.sh: nightly repo hygiene at 23:30, read-only.
#
# bin/janitor.mjs decides every merged branch, unreferenced plan, closed
# .agents ledger row and stale worktree in the repos touched today with the
# decision table in policies/repo-hygiene.mjs, and records what each cell
# would do. Nothing in a repo is touched; a red night leaves one note on the
# repo's ÖPPET NU line.
#
# Report: ~/.agentmux/janitor/reports/<date>.md  Ledger: ~/.agentmux/janitor/ledger.jsonl
# Off:    touch ~/.agentmux/janitor/OFF
set -euo pipefail
if [ -z "${HOME:-}" ]; then
  HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
  export HOME
fi
export PATH="$HOME/.local/bin:/usr/bin:/bin:${PATH:-}"
AGENTMUX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -x "$NODE_BIN" ] || { echo "$(date -Is) janitor FAILED: no node (set NODE_BIN in the crontab line)"; exit 1; }
JANITOR_DIR="${AMUX_JANITOR_DIR:-$HOME/.agentmux/janitor}"
mkdir -p "$JANITOR_DIR"

[ -f "$JANITOR_DIR/OFF" ] && { echo "$(date -Is) janitor OFF, skipped"; exit 0; }
exec 9>"$JANITOR_DIR/.lock"
flock -n 9 || { echo "$(date -Is) janitor already running, skipped"; exit 0; }
if summary="$("$NODE_BIN" "$AGENTMUX_DIR/bin/janitor.mjs" --state-dir "$JANITOR_DIR" "$@")"; then
  echo "$(date -Is) $summary"
else
  status=$?
  echo "$(date -Is) janitor FAILED with exit $status"
  "$NODE_BIN" "$AGENTMUX_DIR/bin/agent-cli.mjs" notifyuser --level error --title "amux janitor" \
    "Nightly read-only janitor failed with exit $status; see its cron log" || true
  exit "$status"
fi
