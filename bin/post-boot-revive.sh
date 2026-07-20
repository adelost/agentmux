#!/usr/bin/env bash
# Run amux revive once per host/WSL boot. Invoked asynchronously by start.sh.

set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$HOME/.agentmux"
MARKER="$STATE_DIR/revive-boot-id"
LOCK="$STATE_DIR/revive-boot.lock"
BOOT_ID=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || true)

[ -n "$BOOT_ID" ] || { echo "[$(date '+%F %T')] revive skipped: no boot id"; exit 1; }
mkdir -p "$STATE_DIR"

exec 9>"$LOCK"
flock -n 9 || exit 0
[ "$(cat "$MARKER" 2>/dev/null || true)" = "$BOOT_ID" ] && exit 0

echo "[$(date '+%F %T')] post-boot revive starting ($BOOT_ID)"

# Panel revive is the one step that mutates panes, and the only step gated on
# a verified release identity: a wrong/forged/linked install keeps the bridge
# as the recovery channel but never writes into 60 panes.
if ! node "$DIR/bin/verify-release-identity.mjs" > "$STATE_DIR/revive-identity.json" 2>&1; then
  echo "[$(date '+%F %T')] post-boot revive REFUSED: release identity failed (see $STATE_DIR/revive-identity.json); panels untouched, recovery channel stays up" >&2
  exit 1
fi

# The revive storm is a proven automatic heavy starter (it launches the whole
# fleet at once). Admission is a live meminfo sample, not the polled state file.
if ! node "$DIR/bin/memory-guard.mjs" check --class pane-revive --reserve-mib 8192; then
  echo "[$(date '+%F %T')] post-boot revive REFUSED: memory admission denied; panels untouched, retry on next serve" >&2
  exit 1
fi

if node "$DIR/bin/agent-cli.mjs" runtime start \
  && node "$DIR/bin/agent-cli.mjs" runtime check --port 8811 \
  && node "$DIR/bin/agent-cli.mjs" revive; then
  printf '%s\n' "$BOOT_ID" > "$MARKER"
  echo "[$(date '+%F %T')] post-boot revive complete"
else
  echo "[$(date '+%F %T')] post-boot revive failed; next serve will retry" >&2
  exit 1
fi
