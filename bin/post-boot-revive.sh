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
if node "$DIR/bin/agent-cli.mjs" revive; then
  printf '%s\n' "$BOOT_ID" > "$MARKER"
  echo "[$(date '+%F %T')] post-boot revive complete"
else
  echo "[$(date '+%F %T')] post-boot revive failed; next serve will retry" >&2
  exit 1
fi
