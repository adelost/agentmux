#!/usr/bin/env bash
# fleet-progress-cron.sh — the "nobody's moving and nobody noticed" watchdog.
#
# WHY: two failure classes were invisible until a human happened to look
# (Mattias, 2026-07-14: "det känns inte som att agenterna jobbar"):
#   (A) a broker closes a ticket-wave and never dispatches the next one, so
#       its whole fleet idles with work still in the backlog (skydive:3 sat a
#       wave-gap for hours; nobody was hung, nobody was working either).
#   (B) a delivery-queue job wedges in a non-terminal state (submitted with no
#       JSONL receipt) and lingers forever — the FIFO is not blocked (claw:3's
#       decouple fix), but the job never terminalises so it silently rots.
#
# task-keeper watches a REGISTERED lane's own task progress; backlog-pull
# auto-dispatches the ai-dsl FE lane. Neither sees (A) fleet-wide broker gaps
# or (B) transport wedges. This closes both, fleet-agnostically.
#
# WHAT each run (~every 20 min via cron) does:
#   1. Queue sweep (B): any delivery-queue job non-terminal + older than
#      STUCK_MIN + never acknowledged → notifyuser ONCE per job-id + log.
#      Surface-only: it never mutates the queue (that terminal-timeout root-fix
#      is claw:3's delivery-queue.mjs lane). We report, the owner terminalises.
#   2. Fleet sweep (A): for each watched fleet (session + broker pane + repo),
#      progress = max(newest repo commit, broker pane's session-jsonl mtime).
#        * broker jsonl fresh (<ACTIVE_SEC) → broker is mid-turn, NEVER nudge.
#        * progress age < STALE_MIN → fleet is moving, clear any warning.
#        * stale once  → nudge the BROKER to re-inventory + dispatch (it owns
#                        dispatch; we delegate the "why", we don't micromanage
#                        tickets). Per-fleet cooldown prevents spam.
#        * stale twice → amux notifyuser (human escalation), keep nudging.
#
# Why nudge the broker, not the workers: single-owner rule. The broker owns
# flow; waking individual workers would cross ownership and risk reviving
# panes a human deliberately parked. A re-inventory nudge is self-checking —
# if nothing is READY the broker just confirms idle (cheap no-op).
#
# CONFIG:  ~/.agentmux/fleet-watch/fleets.conf   (one fleet per line)
#            <session> <broker_pane> <repo_abspath>   # '#' comments ok
# OFF:     per-fleet  touch ~/.agentmux/fleet-watch/<session>.OFF
#          global     touch ~/.agentmux/fleet-watch/OFF
# Install: */20 * * * * .../bin/fleet-progress-cron.sh >> ~/.cache/fleet-progress.log 2>&1
set -uo pipefail
export HOME="${HOME:-/home/adelost}"
export PATH="${HOME}/.nvm/versions/node/v22.19.0/bin:${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin"
AMUX="${AMUX:-${HOME}/.nvm/versions/node/v22.19.0/bin/amux}"
PY="${PY:-python3}"

WATCH_DIR="${WATCH_DIR:-${HOME}/.agentmux/fleet-watch}"   # overridable for tests
QUEUE_DIR="${QUEUE_DIR:-${HOME}/.agentmux/delivery-queue}"
CONF="${CONF:-${WATCH_DIR}/fleets.conf}"
STALE_MIN="${STALE_MIN:-60}"        # fleet quiet this long → broker gap (Mattias: "en timme")
STUCK_MIN="${STUCK_MIN:-60}"        # queue job non-terminal this long → surface
ACTIVE_SEC="${ACTIVE_SEC:-150}"     # broker jsonl fresher than this → mid-turn, never interrupt
COOLDOWN_MIN="${COOLDOWN_MIN:-60}"  # per-fleet re-nudge cooldown
DRY="${DRY:-0}"

mkdir -p "$WATCH_DIR"
[ -f "${WATCH_DIR}/OFF" ] && { echo "[$(date -Is)] global OFF → skip"; exit 0; }

# Single-instance: a nudge to a busy pane can take seconds; under a */20 cron a
# slow run must never stack on top of the previous one.
exec 9>"${WATCH_DIR}/.lock"
flock -n 9 || { echo "[$(date -Is)] another run holds the lock → skip"; exit 0; }

log() { echo "[$(date -Is)] $*"; }
now=$(date +%s)

# amux verified delivery blocks until it can prove the send (retries on a busy
# pane). The durable queue write happens FIRST, so the bridge delivers async
# even if we abandon the client wait — time-box it so one busy pane can't hang
# the whole sweep. SEND_TIMEOUT overridable for tests.
SEND_TIMEOUT="${SEND_TIMEOUT:-25}"
amux_send() { timeout "$SEND_TIMEOUT" "$AMUX" "$@"; }

# Newest Claude/Codex session-jsonl mtime for a pane, or 0 if unresolvable.
# Mirrors task-keeper's helper: the pane's cwd → project slug ('/' and '.' → '-')
# → ~/.claude/projects/<slug>/*.jsonl. Codex panes fall back to ~/.codex.
# Rotation-safe: newest mtime across the dir. Never crashes on a missing pane.
pane_jsonl_mtime() {
  local agent="$1" pane="$2" cwd slug newest=0 m f
  cwd=$(tmux display-message -t "${agent}:.${pane}" -p '#{pane_current_path}' 2>/dev/null)
  [ -z "$cwd" ] && { echo 0; return 0; }
  slug="${cwd//\//-}"; slug="${slug//./-}"
  for f in "${HOME}/.claude/projects/${slug}"/*.jsonl; do
    [ -e "$f" ] || continue
    m=$(stat -c %Y "$f" 2>/dev/null || echo 0); [ "$m" -gt "$newest" ] && newest=$m
  done
  echo "$newest"
}

pane_exists() { tmux has-session -t "$1" 2>/dev/null && tmux display-message -t "${1}:.${2}" -p '' >/dev/null 2>&1; }

# ── 1. Queue sweep (B): surface non-terminal wedged jobs. ─────────────────────
QSTATE="${WATCH_DIR}/queue-warned.state"   # one wedged job-id per line, already alerted
touch "$QSTATE"
if [ -d "$QUEUE_DIR" ]; then
  # python does the ms-epoch + JSON parsing; prints one TSV line per stuck job:
  #   <jobfile>\t<agent>\t<pane>\t<status>\t<age_min>\t<texthead>
  mapfile -t STUCK < <("$PY" - "$QUEUE_DIR" "$STUCK_MIN" <<'PY'
import json, glob, os, sys, time
qdir, stuck_min = sys.argv[1], float(sys.argv[2])
now = time.time()
TERMINAL = {"delivered", "acknowledged", "acked", "failed", "dead", "dead-letter",
            "done", "cancelled", "canceled", "delivered-unverified"}
for f in glob.glob(os.path.join(qdir, "*", "*.json")):
    try:
        d = json.load(open(f))
    except Exception:
        continue
    status = str(d.get("status") or d.get("state") or "").lower()
    if not status or status in TERMINAL:
        continue
    if d.get("acknowledgedAt"):
        continue
    ts = d.get("createdAt") or d.get("submittedAt") or d.get("enqueuedAt") or 0
    try:
        ts = float(ts)
        secs = (now - ts/1000) if ts > 1e12 else (now - ts)
    except Exception:
        continue
    age_min = secs / 60
    if age_min < stuck_min:
        continue
    head = (d.get("text") or "").replace("\n", " ")[:60]
    print(f"{f}\t{d.get('agentName','?')}\t{d.get('pane','?')}\t{status}\t{age_min:.0f}\t{head}")
PY
)
  for row in "${STUCK[@]:-}"; do
    [ -z "$row" ] && continue
    IFS=$'\t' read -r jf jagent jpane jstatus jage jhead <<<"$row"
    jid=$(basename "$jf" .json)
    if grep -qxF "$jid" "$QSTATE"; then
      log "queue: $jagent:$jpane $jid still stuck (${jage}min, $jstatus) — already alerted"
      continue
    fi
    log "queue: STUCK $jagent:$jpane $jid ${jage}min $jstatus :: $jhead"
    if [ "$DRY" != "1" ]; then
      amux_send notifyuser --level error "[fleet-watch] leveranskö-jobb fast ${jage}min → $jagent:$jpane ($jstatus). Rotorsak-fix hos ägaren; jobb-id $jid" || true
      echo "$jid" >> "$QSTATE"
    fi
  done
else
  log "queue: no queue dir at $QUEUE_DIR → skip sweep"
fi

# ── 2. Fleet sweep (A): nudge a broker whose fleet went quiet. ────────────────
[ -f "$CONF" ] || { log "no fleets.conf at $CONF → fleet sweep skipped"; exit 0; }

while read -r session pane repo _rest; do
  [ -z "${session:-}" ] && continue
  case "$session" in \#*) continue;; esac
  [ -z "${pane:-}" ] || [ -z "${repo:-}" ] && { log "$session: bad conf line, skip"; continue; }
  [ -f "${WATCH_DIR}/${session}.OFF" ] && { log "$session: per-fleet OFF → skip"; continue; }
  if ! pane_exists "$session" "$pane"; then log "$session:$pane: pane gone → skip"; continue; fi

  # repo may be a comma-separated list (a fleet can span World/Game/etc repos);
  # progress = the newest commit across ALL of them.
  commit_ts=0
  IFS=',' read -ra _repos <<<"$repo"
  for _r in "${_repos[@]}"; do
    ct=$(git -C "$_r" log -1 --format=%ct 2>/dev/null || echo 0)
    [ "$ct" -gt "$commit_ts" ] && commit_ts=$ct
  done
  jsonl_ts=$(pane_jsonl_mtime "$session" "$pane")
  progress=$(( commit_ts > jsonl_ts ? commit_ts : jsonl_ts ))
  age_min=$(( (now - progress) / 60 ))
  broker_idle_sec=$(( jsonl_ts > 0 ? now - jsonl_ts : 999999 ))

  warn="${WATCH_DIR}/${session}.warned"
  cd_file="${WATCH_DIR}/${session}.cooldown"

  # Broker mid-turn → never interrupt (even if repo commits are old: it may be
  # reviewing/about to dispatch). jsonl freshness is the pane-liveness signal.
  if [ "$jsonl_ts" -gt 0 ] && [ "$broker_idle_sec" -lt "$ACTIVE_SEC" ]; then
    log "$session:$pane: broker active ${broker_idle_sec}s ago → skip"
    continue
  fi
  if [ "$age_min" -lt "$STALE_MIN" ]; then
    rm -f "$warn"
    log "$session:$pane: OK (framdrift ${age_min}min sedan)"
    continue
  fi

  # Cooldown: don't re-nudge the same fleet within COOLDOWN_MIN.
  if [ -f "$cd_file" ]; then
    last_cd=$(cat "$cd_file" 2>/dev/null || echo 0)
    if [ $(( (now - last_cd) / 60 )) -lt "$COOLDOWN_MIN" ]; then
      log "$session:$pane: stale ${age_min}min but in cooldown → skip"
      continue
    fi
  fi

  escalate=0
  [ -f "$warn" ] && escalate=1

  repo_label=$(basename "${_repos[0]}")
  MSG="[fleet-watch, automatisk] Inga commits i ${repo_label} och du (broker) idle i ${age_min}min. Re-inventera READY-kön NU: dispatcha oberoende arbete till lediga paneler (en ägare/ticket, inga fil-krockar), ELLER om inget är READY/allt blockerat — bekräfta det i en rad så vakten ser dig. Om en panel hänger: checkpointa + ge nästa oberoende item. Tysta din flotta: touch ~/.agentmux/fleet-watch/${session}.OFF"

  if [ "$DRY" = "1" ]; then
    log "$session:$pane: DRY would nudge (${age_min}min, escalate=$escalate)"
    continue
  fi

  amux_send "$session" -p "$pane" "$MSG" >/dev/null 2>&1 \
    || log "$session:$pane: nudge send timed out/failed (durably enqueued regardless)"
  echo "$now" > "$cd_file"
  if [ "$escalate" = "1" ]; then
    amux_send notifyuser --level error "[fleet-watch] $session:$pane broker: ingen framdrift på ${age_min}min trots knuff — behöver din blick" || true
    log "$session:$pane: ESCALATED (${age_min}min)"
  else
    touch "$warn"
    log "$session:$pane: NUDGED (${age_min}min)"
  fi
done < "$CONF"
