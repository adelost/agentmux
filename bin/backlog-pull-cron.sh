#!/usr/bin/env bash
# backlog-pull-cron.sh — optional idle→pull-backlog safety net for one configured fleet.
#
# WHY: panes go to message-driven standby when the active queue drains. If
# nobody dispatches, they can idle with an open backlog. This is the mechanism,
# not just a rule.
#
# WHAT it does each run (~every 15 min via cron):
#   1. If ANY configured code pane is currently working (🟢) → EXIT. Never interrupt.
#   2. Find the top open [🔵] item in the configured backlog that is
#      ready (has a spec link), FE-eligible (spec not owned by another pane and
#      not GPU-tagged — derived from the spec header, no hardcoded item#), and
#      not in cooldown.
#   3. Dispatch exactly ONE item to the configured writer pane. The pane goes
#      🟢 → next run hits guard #1 and skips, so no spam.
#   4. Record the dispatch (item# + epoch) for a per-item cooldown.
#
# Safe by design: only fires when every configured code pane is idle, dispatches one
# ready-spec item, has a cooldown, logs everything. Disable: comment the
# crontab line, or `touch ~/.agentmux-backlog-pull.OFF`.

set -uo pipefail
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

REPO="${REPO:-}"
BACKLOG="${BACKLOG:-}"
AMUX_AGENT="${AMUX_AGENT:-}"
STATE="${STATE:-$HOME/.agentmux-backlog-pull.state}"   # last dispatched: "ITEM EPOCH"
OFF_FLAG="${OFF_FLAG:-$HOME/.agentmux-backlog-pull.OFF}"
WRITER_PANE="${WRITER_PANE:-1}"
COOLDOWN_SEC=5400                              # 90 min per-item cooldown
DRY="${DRY:-0}"                                # DRY=1 → print, don't send
NOW=$(date +%s)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=guard-heartbeat.sh
source "$SCRIPT_DIR/guard-heartbeat.sh"
guard_heartbeat_arm "backlog-pull" 900
guard_heartbeat_metric dry "$DRY"
guard_heartbeat_metric outcome started

log() { echo "[$(date '+%F %T')] $*"; }

[ -n "$REPO" ] && [ -n "$BACKLOG" ] && [ -n "$AMUX_AGENT" ] \
  || { guard_heartbeat_metric outcome unconfigured; log "disabled: set REPO, BACKLOG, and AMUX_AGENT"; exit 0; }
[ -f "$OFF_FLAG" ] && { guard_heartbeat_metric outcome disabled; log "OFF flag present → skip"; exit 0; }
[ -f "$BACKLOG" ] || { guard_heartbeat_metric outcome noBacklog; log "no backlog file → skip"; exit 0; }

# ── Guard 1: never interrupt active work. ──
# Grab the configured agent block from amux ps; if any pane line shows 🟢 → busy.
PS="$(amux ps 2>/dev/null)"
AGENT_BLOCK="$(printf '%s\n' "$PS" | awk -v agent="$AMUX_AGENT" '$0 ~ "● " agent " "{f=1;next} /● [a-z]/{f=0} f')"
if printf '%s\n' "$AGENT_BLOCK" | grep -q '🟢'; then
  guard_heartbeat_metric outcome activeFleet
  log "a $AMUX_AGENT pane is working (🟢) → skip"
  exit 0
fi

# ── Find top ready [🔵] item OWNED BY / suitable for the FE pane. ──
# Backlog lines look like:  ### [🔵] 11. Delad <EmptyState>-lego — ...
# This cron only pokes one configured writer, so an item is eligible ONLY if its
# linked spec is not tagged for another pane and does not require GPU. Owner/GPU
# live in the spec header ('**Owner:** agent:N', '**GPU:** ...'). No hardcoded item
# numbers — the filter derives eligibility from the spec, so new GPU/backend
# items (e.g. #20) are skipped automatically instead of mis-routing to FE.
pick_num=""; pick_title=""; SPEC=""
while IFS= read -r line; do
  num="$(printf '%s' "$line" | sed -nE 's/^### \[🔵\] ([0-9]+)\..*/\1/p')"
  [ -z "$num" ] && continue
  title="$(printf '%s' "$line" | sed -E 's/^### \[🔵\] [0-9]+\. //')"

  # Resolve the spec link (first TASK-*.md under this item's header). grep -F on
  # the literal header avoids regex/emoji escaping; -A6 grabs the lines under it.
  spec="$(grep -A6 -F "### [🔵] $num. $title" "$BACKLOG" \
    | grep -oE 'TASK-[A-Za-z0-9._-]+\.md' | head -1)"

  # Owner/GPU filter — read the spec header (top of file) and skip work that
  # belongs to another pane or needs a GPU. FE lane can't build those.
  if [ -n "$spec" ] && [ -f "$REPO/.planning/$spec" ]; then
    header="$(head -12 "$REPO/.planning/$spec")"
    owner="$(printf '%s' "$header" | sed -nE 's/.*([Ää]gare|Owner):\**[[:space:]]*([A-Za-z0-9_-]+:[0-9]+).*/\2/p' | head -1)"
    if [ -n "$owner" ] && [ "$owner" != "$AMUX_AGENT:$WRITER_PANE" ]; then
      log "skip #$num — spec owner $owner != $AMUX_AGENT:$WRITER_PANE"; continue
    fi
    if printf '%s' "$header" | grep -qiE 'GPU|home[ -]?OFF|3090|4090|5090'; then
      log "skip #$num — spec requires GPU (not FE lane)"; continue
    fi
  fi

  pick_num="$num"; pick_title="$title"; SPEC="$spec"
  break
done < <(grep -E '^### \[🔵\] [0-9]+\.' "$BACKLOG")

[ -z "$pick_num" ] && { guard_heartbeat_metric outcome drained; log "no FE-eligible ready 🔵 item → backlog drained / all blocked or non-FE → skip"; exit 0; }

# ── Cooldown: don't re-dispatch the same item within COOLDOWN_SEC. ──
if [ -f "$STATE" ]; then
  read -r last_item last_epoch < "$STATE" 2>/dev/null || true
  if [ "${last_item:-}" = "$pick_num" ] && [ $((NOW - ${last_epoch:-0})) -lt "$COOLDOWN_SEC" ]; then
    log "item #$pick_num still in cooldown ($(( (COOLDOWN_SEC-(NOW-last_epoch))/60 ))min left) → skip"
    guard_heartbeat_metric outcome cooldown
    guard_heartbeat_metric item "$pick_num"
    exit 0
  fi
fi

spec_txt="${SPEC:+spec .planning/$SPEC}"
[ -z "$spec_txt" ] && spec_txt="see backlog #$pick_num in $BACKLOG"

MSG="AUTO-PULL (the configured fleet is idle): take backlog #$pick_num — $pick_title. $spec_txt. Keep one owner, run scoped checks, and commit the result. If it is blocked or needs unavailable hardware, report the concrete blocker without taking unrelated work."

if [ "$DRY" = "1" ]; then
  guard_heartbeat_metric outcome dryDispatch
  guard_heartbeat_metric item "$pick_num"
  log "DRY: would dispatch #$pick_num to $AMUX_AGENT:$WRITER_PANE → $pick_title"
  log "DRY: msg = $MSG"
  exit 0
fi

amux "$AMUX_AGENT" -p "$WRITER_PANE" "$MSG" >/dev/null 2>&1 \
  && { echo "$pick_num $NOW" > "$STATE"; guard_heartbeat_metric outcome dispatched; guard_heartbeat_metric item "$pick_num"; log "dispatched #$pick_num ($pick_title) → $AMUX_AGENT:$WRITER_PANE"; } \
  || { guard_heartbeat_disarm; log "amux send FAILED for #$pick_num"; exit 1; }
