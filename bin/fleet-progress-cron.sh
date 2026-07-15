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
#   3. Review-queue sweep (C): any open PR in a watched repo older than
#      PR_STALE_MIN → nudge the fleet's broker (it owns merge), re-nudge per
#      PR_COOLDOWN_MIN. The fleet sweep only sees total silence; this catches
#      a BUSY broker whose review queue quietly ages (SRC-0012 sat 7h+ while
#      its broker worked other reviews, 2026-07-15). Label a PR "parked" to
#      intentionally exempt it.
#
# Why nudge the broker, not the workers: single-owner rule. The broker owns
# flow; waking individual workers would cross ownership and risk reviving
# panes a human deliberately parked. A re-inventory nudge is self-checking —
# if nothing is READY the broker just confirms idle (cheap no-op).
#
# CONFIG:  ~/.agentmux/fleet-watch/fleets.conf   (one fleet per line)
#            <session> <broker_pane> <repo_abspath>   # '#' comments ok
# OFF:     per-fleet  touch ~/.agentmux/fleet-watch/<session>.OFF  (PERMANENT, human-only)
#          global     touch ~/.agentmux/fleet-watch/OFF
# SNOOZE:  broker     touch ~/.agentmux/fleet-watch/<session>.snooze (AUTO-expires in
#          SNOOZE_HOURS; a broker's "nothing READY now" — never permanent, so a
#          stale point-in-time audit can't blind the watch to later tickets)
# Install: */20 * * * * .../bin/fleet-progress-cron.sh >> ~/.cache/fleet-progress.log 2>&1
set -uo pipefail
export HOME="${HOME:-/home/adelost}"
export PATH="${HOME}/.nvm/versions/node/v22.19.0/bin:${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin"
AMUX="${AMUX:-${HOME}/.nvm/versions/node/v22.19.0/bin/amux}"
PY="${PY:-python3}"

# The agent server runs on a NAMED socket (agent-cli.mjs: TMUX_SOCKET ||
# /tmp/openclaw-claude.sock). Bare `tmux` only finds it when invoked from
# inside that server ($TMUX set) — from cron it hits the default socket,
# sees no server, and every pane check returns "gone". That killed the
# entire fleet sweep silently from its FIRST cron run (223 'pane gone'
# rows, 2026-07-14..15) while manual runs worked. Shadow tmux so every
# call site targets the right socket in both contexts.
TMUX_SOCKET="${TMUX_SOCKET:-/tmp/openclaw-claude.sock}"
tmux() { command tmux -S "$TMUX_SOCKET" "$@"; }

WATCH_DIR="${WATCH_DIR:-${HOME}/.agentmux/fleet-watch}"   # overridable for tests
QUEUE_DIR="${QUEUE_DIR:-${HOME}/.agentmux/delivery-queue}"
CONF="${CONF:-${WATCH_DIR}/fleets.conf}"
STALE_MIN="${STALE_MIN:-60}"        # fleet quiet this long → broker gap (Mattias: "en timme")
STUCK_MIN="${STUCK_MIN:-60}"        # queue job non-terminal this long → surface
ACTIVE_SEC="${ACTIVE_SEC:-150}"     # broker jsonl fresher than this → mid-turn, never interrupt
COOLDOWN_MIN="${COOLDOWN_MIN:-60}"  # per-fleet re-nudge cooldown
SNOOZE_HOURS="${SNOOZE_HOURS:-3}"   # broker "nothing READY" self-snooze; AUTO-expires
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

# `amux <name> -p N "msg"` routes to a SUBCOMMAND when <name> equals one (e.g. a
# session literally named "ps" can never be a send target). `amux :index`
# sidesteps it but the index is alphabetical over the config and shifts when
# agents are added/removed — too fragile to send from a cron (it WILL misfire
# to the wrong pane). So a collision-named fleet is escalated to a human
# instead of auto-nudged. Exception: "watch" is NOT reserved — the CLI
# disambiguates it (shouldRouteWatchToAgent routes `amux watch -p N "msg"`
# to the session whenever a positional message is present).
RESERVED_CMDS=" ps top done log timeline dream compact janitor asks ask questions search serve stop doctor queue edit label labels lint select image say events run plan resume r esc wait notifyuser remind memory ls help playwright-reap pw-reap "
is_reserved() { case "$RESERVED_CMDS" in *" $1 "*) return 0;; *) return 1;; esac; }

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
# Must match core/delivery-queue.mjs TERMINAL_DELIVERY_STATES exactly.
# 1.23.8 added "delivered_unverified" (UNDERSCORE) — a hyphen here would make a
# terminalised job look stuck and fire a false "wedged queue" alert.
TERMINAL = {"acknowledged", "cancelled", "delivered_unverified",
            "delivered", "acked", "failed", "canceled", "done", "dead"}
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
[ -f "$CONF" ] || { log "no fleets.conf at $CONF → fleet + review-queue sweeps skipped"; exit 0; }

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
  snooze="${WATCH_DIR}/${session}.snooze"

  # Broker mid-turn → never interrupt (even if repo commits are old: it may be
  # reviewing/about to dispatch). jsonl freshness is the pane-liveness signal.
  if [ "$jsonl_ts" -gt 0 ] && [ "$broker_idle_sec" -lt "$ACTIVE_SEC" ]; then
    log "$session:$pane: broker active ${broker_idle_sec}s ago → skip"
    continue
  fi
  if [ "$age_min" -lt "$STALE_MIN" ]; then
    rm -f "$warn" "$snooze"   # progress made → clear any self-snooze
    log "$session:$pane: OK (framdrift ${age_min}min sedan)"
    continue
  fi

  # Broker self-snooze: a broker that confirmed "nothing READY" touches this
  # file. Unlike .OFF (permanent, human-only), the snooze AUTO-EXPIRES via its
  # mtime — a broker can never permanently blind the watch on a point-in-time
  # audit (the ai:3/AI-0004 miss, 2026-07-14). Expired → remove and proceed.
  if [ -f "$snooze" ]; then
    snooze_age_min=$(( (now - $(stat -c %Y "$snooze" 2>/dev/null || echo 0)) / 60 ))
    if [ "$snooze_age_min" -lt $(( SNOOZE_HOURS * 60 )) ]; then
      log "$session:$pane: broker-snoozed ($(( SNOOZE_HOURS * 60 - snooze_age_min ))min kvar) → skip"
      continue
    fi
    rm -f "$snooze"
    log "$session:$pane: snooze expired → re-arming"
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
  MSG="[fleet-watch, automatisk] Inga commits i ${repo_label} och du (broker) idle i ${age_min}min. Re-inventera READY-kön NU: dispatcha oberoende arbete till lediga paneler (en ägare/ticket, inga fil-krockar), ELLER om inget är READY/allt blockerat — bekräfta det i en rad så vakten ser dig. Om en panel hänger: checkpointa + ge nästa oberoende item. Om inget är READY: touch ~/.agentmux/fleet-watch/${session}.snooze (tystar dig ${SNOOZE_HOURS}h, vaknar sen automatiskt så nya tickets inte missas). Sätt ALDRIG .OFF själv — den är permanent och bara för Mattias."

  if is_reserved "$session"; then
    if [ "$DRY" = "1" ]; then log "$session:$pane: DRY reserved-name → would escalate (${age_min}min)"; continue; fi
    amux_send notifyuser --level warn "[fleet-watch] $session:$pane broker tyst ${age_min}min men sessionsnamnet krockar med ett amux-subkommando → kan inte auto-knuffa säkert. Knuffa manuellt." >/dev/null 2>&1 || true
    echo "$now" > "$cd_file"; touch "$warn"
    log "$session:$pane: RESERVED-NAME collision → escalated to human (no auto-nudge)"
    continue
  fi

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

# ── 3. Review-queue sweep (C): a banked PR nobody reviews is invisible rot. ───
# Independent of the fleet sweep's skip logic ON PURPOSE: a broker that is
# actively working (fresh jsonl → fleet sweep skips) can still let its review
# queue age for hours. Snooze does NOT apply here — "nothing READY" says
# nothing about banked PRs; review IS the broker's work. .OFF still applies.
PR_STALE_MIN="${PR_STALE_MIN:-240}"       # open PR older than this → nudge broker
PR_COOLDOWN_MIN="${PR_COOLDOWN_MIN:-240}" # per-PR re-nudge interval
PRSTATE="${WATCH_DIR}/pr-nudged.state"    # "<repo>#<num> <last_nudge_epoch>" per line
GH="${GH:-/usr/bin/gh}"
touch "$PRSTATE"
if [ ! -x "$GH" ]; then
  log "review-queue: gh not found at $GH → sweep skipped (fix PATH/GH)"
else
  while read -r session pane repo _rest; do
    [ -z "${session:-}" ] && continue
    case "$session" in \#*) continue;; esac
    [ -z "${pane:-}" ] || [ -z "${repo:-}" ] && continue
    [ -f "${WATCH_DIR}/${session}.OFF" ] && { log "review-queue: $session per-fleet OFF → skip"; continue; }
    if ! pane_exists "$session" "$pane"; then continue; fi

    due=""   # newline-separated "repo#num (ageh) title" rows past cooldown
    IFS=',' read -ra _repos <<<"$repo"
    for _r in "${_repos[@]}"; do
      rlabel=$(basename "$_r")
      # One TSV row per stale open PR: <key>\t<age_h>\t<title>. "parked" label
      # = intentionally exempt. gh failure → empty sweep for that repo.
      # JSON goes via argv: python's stdin already carries the heredoc program.
      pr_json=$( (cd "$_r" 2>/dev/null && timeout 20 "$GH" pr list --state open \
        --json number,title,createdAt,labels --limit 30) 2>/dev/null ) || pr_json="[]"
      rows=$("$PY" - "$rlabel" "$PR_STALE_MIN" "$pr_json" <<'PY'
import json, sys
from datetime import datetime, timezone
label, stale_min = sys.argv[1], float(sys.argv[2])
try:
    prs = json.loads(sys.argv[3])
except Exception:
    sys.exit(0)
now = datetime.now(timezone.utc)
for pr in prs:
    if any(l.get("name") == "parked" for l in pr.get("labels", [])):
        continue
    try:
        created = datetime.fromisoformat(pr["createdAt"].replace("Z", "+00:00"))
    except Exception:
        continue
    age_min = (now - created).total_seconds() / 60
    if age_min < stale_min:
        continue
    title = str(pr.get("title", ""))[:70].replace("\t", " ")
    print(f"{label}#{pr['number']}\t{age_min/60:.0f}\t{title}")
PY
) || rows=""
      [ -z "$rows" ] && continue
      while IFS=$'\t' read -r key age_h title; do
        [ -z "$key" ] && continue
        last=$(awk -v k="$key" '$1 == k { print $2 }' "$PRSTATE" | tail -1)
        if [ -n "$last" ] && [ $(( (now - last) / 60 )) -lt "$PR_COOLDOWN_MIN" ]; then
          log "review-queue: $key stale ${age_h}h but in cooldown → skip"
          continue
        fi
        due="${due}${key} öppen ${age_h}h: ${title}"$'\n'
      done <<<"$rows"
    done
    [ -z "$due" ] && continue

    MSG="[fleet-watch, automatisk] Review-kön åldras — öppna PR äldre än $(( PR_STALE_MIN / 60 ))h i din flottas repos:
${due}Du äger merge: reviewa+merga per merge-by-proof, ELLER kommentera på PR:en varför den väntar och sätt labeln 'parked' om den medvetet ska ligga."
    if [ "$DRY" = "1" ]; then
      log "$session:$pane: DRY would nudge review-queue: $(echo "$due" | tr '\n' ' ')"
      continue
    fi
    if is_reserved "$session"; then
      amux_send notifyuser --level warn "[fleet-watch] $session:$pane har åldrande review-kö men sessionsnamnet krockar med amux-subkommando → knuffa manuellt: $(echo "$due" | tr '\n' ' ')" >/dev/null 2>&1 || true
    else
      amux_send "$session" -p "$pane" "$MSG" >/dev/null 2>&1 \
        || log "$session:$pane: review-queue nudge send timed out/failed (durably enqueued regardless)"
    fi
    # Stamp cooldown per nudged PR (replace-or-append keyed on "<repo>#<num>").
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      key="${line%% *}"
      grep -v "^${key} " "$PRSTATE" > "${PRSTATE}.tmp" 2>/dev/null || true
      echo "$key $now" >> "${PRSTATE}.tmp"
      mv "${PRSTATE}.tmp" "$PRSTATE"
    done <<<"$due"
    log "$session:$pane: REVIEW-QUEUE NUDGED: $(echo "$due" | tr '\n' ' ')"
  done < "$CONF"
fi
