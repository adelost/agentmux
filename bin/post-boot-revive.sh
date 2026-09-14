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
# One JSON string field from the identity report, without node: the remote
# rescue answer must carry the reason even when node itself is what broke.
identity_field() {
  sed -n "s/^[[:space:]]*\"$1\":[[:space:]]*\"\(.*\)\",\{0,1\}[[:space:]]*$/\1/p" "$STATE_DIR/revive-identity.json" | head -n 1
}
if ! node "$DIR/bin/verify-release-identity.mjs" > "$STATE_DIR/revive-identity.json" 2>&1; then
  reason="$(identity_field reason)"
  detail="$(identity_field detail)"
  echo "[$(date '+%F %T')] post-boot revive REFUSED: release identity failed: ${reason:-unknown}: ${detail:-see $STATE_DIR/revive-identity.json}; fix: node bin/install-release.mjs --sha <origin/master sha>, then amux revive; panels untouched, recovery channel stays up" >&2
  exit 1
fi
# A warning (master has unreleased merges) never blocks: the installed
# release is intact, so panes revive on it and the log says how to update.
warning="$(identity_field warning)"
[ -n "$warning" ] && echo "[$(date '+%F %T')] post-boot revive WARN: ${warning}; revive continues on the installed release" >&2

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
