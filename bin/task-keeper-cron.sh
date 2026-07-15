#!/usr/bin/env bash
# task-keeper — durable stuck-watch for agent lanes working a task queue.
#
# PATTERN (generalized from backlog-pull-cron.sh): a system cron sends nudges,
# the AGENT owns its own off-switch. api:0's session-crons burn tokens and die
# with the session; this is free shell and survives everything.
#
# A lane is watched iff an ON-file exists:  ~/.agentmux-keeper/<name>.ON
# ON-file format (shell vars, one per line):
#   AGENT=ai            # amux session
#   PANE=3              # amux pane
#   REPO=/home/adelost/lsrc/ai-dsl
#   TASKFILE=.planning/TASK-M9-operation-model-lint.md   # pointer used in the nudge
#   LOGFILE=.planning/M9-LOG.md                          # wave-log; its mtime = progress signal
#   STALE_MIN=110       # optional, default 110 (just under 2h cron cadence)
#   JSONL_GLOB=...      # optional override for the pane's session-jsonl glob
#                       #   (default: derived from the pane's tmux cwd; only set
#                       #    it when the pane's cwd doesn't match its Claude
#                       #    project dir, or for testing)
#
# Progress signal — pane-specific first, repo second:
#   * The pane's Claude session-jsonl mtime is the AUTHORITATIVE liveness signal
#     when it can be resolved: Claude Code appends to it continuously while the
#     pane works. Signal = max(jsonl mtime, LOGFILE mtime).
#   * Why not just max() in the commit too? A commit is a REPO signal, not a
#     pane signal. It fixes neither failure class and re-introduces (b):
#       (a) pane thinks/builds long without committing  -> was a FALSE nudge
#       (b) pane is dead but a CO-TENANT agent commits   -> was a FALSE green
#     jsonl distinguishes THIS pane from a repo co-tenant; commit cannot.
#   * Fallback: if the jsonl can't be resolved (no tmux pane, no session dir),
#     degrade to the old signal = max(LOGFILE mtime, last commit in REPO). Never
#     crash on a missing pane/session — signal-degradation, not failure.
#
# Stale once => nudge the pane (self-documenting: includes the off-switch
# instruction). Stale twice in a row => amux notifyuser (human escalation),
# then keep nudging.
#
# AGENT OFF-SWITCH (put this in the agent's brief): when the queue is DONE,
# run:  rm ~/.agentmux-keeper/<name>.ON   — and say so in your report.
#
# Install:  */29 * * * *  .../bin/task-keeper-cron.sh >> ~/.cache/task-keeper.log 2>&1
set -uo pipefail
export HOME="${HOME:-/home/adelost}"
export PATH="${HOME}/.nvm/versions/node/v22.19.0/bin:${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin"
AMUX="${AMUX:-${HOME}/.nvm/versions/node/v22.19.0/bin/amux}"
KEEPER_DIR="${KEEPER_DIR:-${HOME}/.agentmux-keeper}"   # overridable for tests
[ -f "${KEEPER_DIR}/OFF" ] && exit 0          # global kill-switch
mkdir -p "$KEEPER_DIR"

# The agent server runs on a NAMED socket (agent-cli.mjs default); bare tmux
# from cron hits the default socket and resolves no panes, silently forcing
# the jsonl fallback path on every run. Same fix as fleet-progress-cron.sh.
TMUX_SOCKET="${TMUX_SOCKET:-/tmp/openclaw-claude.sock}"
tmux() { command tmux -S "$TMUX_SOCKET" "$@"; }

# Newest Claude session-jsonl mtime for a pane, or 0 if unresolvable. The pane's
# jsonl lives in ~/.claude/projects/<slug>/*.jsonl where <slug> is the pane's
# cwd with every '/' and '.' replaced by '-' (mirrors amux core encodePath()).
# Rotation-safe: takes the newest mtime across all session files in the dir.
pane_jsonl_mtime() {
  local agent="$1" pane="$2" glob_override="${3:-}"
  local glob newest=0 f m cwd slug
  if [ -n "$glob_override" ]; then
    glob="$glob_override"
  else
    cwd=$(tmux display-message -t "${agent}:.${pane}" -p '#{pane_current_path}' 2>/dev/null)
    if [ -z "$cwd" ]; then echo 0; return 0; fi
    slug="${cwd//\//-}"; slug="${slug//./-}"
    glob="${HOME}/.claude/projects/${slug}/*.jsonl"
  fi
  for f in $glob; do
    [ -e "$f" ] || continue
    m=$(stat -c %Y "$f" 2>/dev/null || echo 0)
    [ "$m" -gt "$newest" ] && newest=$m
  done
  echo "$newest"
}

now=$(date +%s)
for on in "$KEEPER_DIR"/*.ON; do
  [ -e "$on" ] || continue
  name=$(basename "$on" .ON)
  AGENT=""; PANE=""; REPO=""; TASKFILE=""; LOGFILE=""; STALE_MIN=110; JSONL_GLOB=""
  # shellcheck disable=SC1090
  source "$on"
  if [ -z "$AGENT" ] || [ -z "$PANE" ] || [ -z "$REPO" ]; then
    echo "[$(date -Is)] $name: bad ON-file, skipping"; continue
  fi

  log_ts=0
  [ -n "$LOGFILE" ] && [ -f "$REPO/$LOGFILE" ] && log_ts=$(stat -c %Y "$REPO/$LOGFILE" 2>/dev/null || echo 0)
  commit_ts=$(git -C "$REPO" log -1 --format=%ct 2>/dev/null || echo 0)
  jsonl_ts=$(pane_jsonl_mtime "$AGENT" "$PANE" "$JSONL_GLOB")

  # Pane-jsonl authoritative when resolvable; else degrade to logfile+commit.
  if [ "$jsonl_ts" -gt 0 ]; then
    last=$(( jsonl_ts > log_ts ? jsonl_ts : log_ts ))
    signal="jsonl+logg"
  else
    last=$(( log_ts > commit_ts ? log_ts : commit_ts ))
    signal="logg+commit (jsonl ej upplöst)"
  fi
  age_min=$(( (now - last) / 60 ))

  warn="$KEEPER_DIR/$name.warned"
  if [ "$age_min" -lt "$STALE_MIN" ]; then
    rm -f "$warn"
    echo "[$(date -Is)] $name: OK (senaste framdrift ${age_min}min sedan, ${signal})"
    continue
  fi

  if [ -f "$warn" ]; then
    "$AMUX" notifyuser --level error "[keeper] $name: ingen framdrift på ${age_min}min trots knuff — behöver mänsklig blick (task: ${TASKFILE:-?})" || true
    echo "[$(date -Is)] $name: ESKALERAD (${age_min}min, ${signal})"
  else
    touch "$warn"
    echo "[$(date -Is)] $name: NUDGE (${age_min}min, ${signal})"
  fi
  "$AMUX" "$AGENT" -p "$PANE" "[keeper, automatisk] Ingen framdrift registrerad på ${age_min} min (våg-logg + commits). Om du JOBBAR: fortsätt — men committa nästa gröna delmängd + skriv en rad i ${LOGFILE:-din våg-logg} så vakten ser dig. Om du är FAST: timebox-regeln — checkpointa + ta nästa OBEROENDE item i ${TASKFILE:-din task-fil}. Om HELA kön är KLAR: stäng av din vakt med \`rm ~/.agentmux-keeper/${name}.ON\` och rapportera till api:0." || true
done
