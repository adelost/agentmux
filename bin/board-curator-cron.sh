#!/usr/bin/env bash
# board-curator-cron.sh — periodic ticket-quality pass, delegated to brokers.
#
# WHY (Mattias, 2026-07-15): tickets rot in three ways nobody owns between
# waves: duplicates accumulate (lsrc:1's retro tickets overlapped SRC-0035/
# 0036 the same night they were filed), unclear tickets stall workers until
# a propose-first round-trip, and "done" sometimes isn't (phantom-close,
# direction misses like PR #32). A periodic curation pass catches all three —
# but it must NEVER generate work on a quiet system ("ska inte trigga
# arbetet i onödan").
#
# WHAT each run (hourly cron) does, per fleet with a board project:
#   1. Compute an ACTIONABLE BOARD FINGERPRINT from triaging, needs_detail,
#      ready, and in_progress counts. Repo commits and terminal/deferred
#      tickets are deliberately excluded: neither creates broker work.
#   2. Fingerprint unchanged since the last pass → silent skip.
#   3. Changed → send the BROKER a curation brief (it has the context and
#      the mandate): merge duplicates, rewrite unclear tickets, re-verify
#      blockers (rule 9), spot-check recently-done tickets against actual
#      PRs/deploys (follow-up ticket or proper reopen if incomplete).
#      Stamp the fingerprint so the next hour is silent unless new motion.
#
# The broker reports only if it changed something — a clean board costs one
# silent read. Delegation, not a standing curator agent (staffing rule 5).
#
# CONFIG: reuses ~/.agentmux/fleet-watch/fleets.conf, 4th column = board
#         project id (lines without one are skipped):
#           <session> <broker_pane> <repos> [board_project]
# OFF:    same switches as fleet-progress (global OFF / <session>.OFF).
# Install: bin/install-board-curator.sh — idempotent, refuses a dangling
#          entry (script must exist on the running checkout). Run AFTER the
#          merge has landed on the checkout the crontab points at.
set -uo pipefail
export HOME="${HOME:-/home/adelost}"
export PATH="${HOME}/.nvm/versions/node/v22.19.0/bin:${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin"
AMUX="${AMUX:-${HOME}/.nvm/versions/node/v22.19.0/bin/amux}"
CURL="${CURL:-curl}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=guard-heartbeat.sh
source "$SCRIPT_DIR/guard-heartbeat.sh"

WATCH_DIR="${WATCH_DIR:-${HOME}/.agentmux/fleet-watch}"
CONF="${CONF:-${WATCH_DIR}/fleets.conf}"
BOARD_URL="${BOARD_URL:-https://suggest.v1d.io}"
READ_TOKEN_FILE="${READ_TOKEN_FILE:-${HOME}/.config/agent/suggestions-read-token}"
CURATE_COOLDOWN_MIN="${CURATE_COOLDOWN_MIN:-55}"   # never more than ~hourly per fleet
DRY="${DRY:-0}"

guard_heartbeat_arm "board-curator" 3600
guard_heartbeat_metric dry "$DRY"
guard_heartbeat_metric fleets 0
guard_heartbeat_metric briefs 0
guard_heartbeat_metric boardFailures 0
fleets=0; briefs=0; board_failures=0

mkdir -p "$WATCH_DIR"
[ -f "${WATCH_DIR}/OFF" ] && { echo "[$(date -Is)] global OFF → skip"; exit 0; }
[ -f "$CONF" ] || { echo "[$(date -Is)] no fleets.conf at $CONF → skip"; exit 0; }

exec 9>"${WATCH_DIR}/.curator-lock"
flock -n 9 || { guard_heartbeat_disarm; echo "[$(date -Is)] another run holds the lock → skip"; exit 0; }

log() { echo "[$(date -Is)] $*"; }
now=$(date +%s)

SEND_TIMEOUT="${SEND_TIMEOUT:-25}"
amux_send() { timeout "$SEND_TIMEOUT" "$AMUX" "$@"; }

# Actionable board fingerprint for a project, or empty on any failure
# (logged loud — a 401/500 here is a health event, never a silent zero).
# Cloudflare requires a real User-Agent (bare python/curl defaults are 403).
board_counts() {
  local project="$1" token
  token=$(cat "$READ_TOKEN_FILE" 2>/dev/null) || { log "$project: no read token at $READ_TOKEN_FILE"; return 1; }
  "$CURL" -sf --max-time 20 -A "amux-board-curator" \
    -H "Authorization: Bearer $token" \
    "${BOARD_URL}/api/tickets/summary?project=${project}" \
    | python3 -c 'import json,sys; c=json.load(sys.stdin).get("counts") or {}; keys=("triaging","needs_detail","ready","in_progress"); actionable={k:int(c.get(k) or 0) for k in keys}; print(sum(actionable.values()), json.dumps(actionable, sort_keys=True))' \
    2>/dev/null
}

while read -r session pane repo project _rest; do
  [ -z "${session:-}" ] && continue
  case "$session" in \#*) continue;; esac
  [ -z "${project:-}" ] && { log "${session:-?}: no board project column → skip"; continue; }
  fleets=$((fleets + 1))
  [ -f "${WATCH_DIR}/${session}.OFF" ] && { log "$session: per-fleet OFF → skip"; continue; }

  counts=$(board_counts "$project") || { counts=""; board_failures=$((board_failures + 1)); }
  if [ -z "$counts" ]; then
    log "$session/$project: board unreachable → silent (cannot prove actionable work)"
    continue
  fi
  actionable_total=${counts%% *}
  fingerprint="board:${counts}"

  stamp="${WATCH_DIR}/${session}.curated"
  if [ "$actionable_total" -eq 0 ]; then
    # Deferred, parked and terminal-only boards are settled state. Refreshing
    # the silent baseline prevents a repo commit or a done-ticket audit update
    # from waking a broker that has nothing executable to do.
    { echo "$now"; echo "$fingerprint"; } > "$stamp"
    log "$session/$project: zero actionable tickets → silent"
    continue
  fi
  if [ ! -f "$stamp" ]; then
    # Bootstrap: no prior point exists, so "motion since last pass" is
    # undefined — claiming it would brief every broker on install day.
    # Establish the baseline silently; the first brief fires on the first
    # REAL motion after this.
    { echo "$now"; echo "$fingerprint"; } > "$stamp"
    log "$session/$project: baseline established (no brief on bootstrap)"
    continue
  fi
  last_fp=$(tail -n +2 "$stamp" 2>/dev/null)
  last_at=$(head -1 "$stamp" 2>/dev/null || echo 0)
  if [ "$fingerprint" = "$last_fp" ]; then
    log "$session/$project: no motion since last pass → silent"
    continue
  fi
  if [ $(( (now - last_at) / 60 )) -lt "$CURATE_COOLDOWN_MIN" ]; then
    log "$session/$project: motion but in cooldown → next hour"
    continue
  fi

  MSG="[board-curator, automatisk] Aktivitet sedan förra kuratorspasset — kör ett KURATORSPASS på boarden (projekt ${project}):
1. INVENTERA icke-done tickets: slå ihop dubletter (länka, stäng den ena med hänvisning), skriv om oklara tickets (konkret problem + förväntat resultat), re-verifiera blockers (regel 9: blocker på boarden eller assigna).
2. STICKPROVA de senast klarmarkerade mot faktisk PR/deploy: ofullständigt implementerad → följdticket eller korrekt reopen, notera varför på ticketen.
3. SANITY: prioritetsordningen speglar aktiva ordrar.
Rapportera BARA om du ändrade något; ren board = tyst. Nästa pass triggas först vid ny aktivitet."

  if [ "$DRY" = "1" ]; then
    log "$session/$project: DRY would send curation brief (fp changed)"
    continue
  fi
  # Stamp ONLY on a verified send (amux exit 0 = delivery proven). A timed-out
  # send may still land later via the durable queue, so the retry next hour
  # can produce a duplicate brief — an idempotent nuisance. The alternative
  # (stamping an unproven send) silently skips a curation pass; correctness
  # wins over the occasional duplicate.
  if amux_send "$session" -p "$pane" "$MSG" >/dev/null 2>&1; then
    { echo "$now"; echo "$fingerprint"; } > "$stamp"
    log "$session/$project: CURATION BRIEF SENT"
    briefs=$((briefs + 1))
  else
    log "$session/$project: send unverified (timeout/fail) — NOT stamped, retrying next run"
  fi
done < "$CONF"
guard_heartbeat_metric fleets "$fleets"
guard_heartbeat_metric briefs "$briefs"
guard_heartbeat_metric boardFailures "$board_failures"
