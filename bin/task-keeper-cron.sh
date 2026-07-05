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
#
# Progress signal = max(LOGFILE mtime, last commit time in REPO). Stale once =>
# nudge the pane (self-documenting: includes the off-switch instruction).
# Stale twice in a row => amux notifyuser (human escalation), then keep nudging.
#
# AGENT OFF-SWITCH (put this in the agent's brief): when the queue is DONE,
# run:  rm ~/.agentmux-keeper/<name>.ON   — and say so in your report.
#
# Install:  */29 * * * *  .../bin/task-keeper-cron.sh >> ~/.cache/task-keeper.log 2>&1
set -uo pipefail
export HOME="${HOME:-/home/adelost}"
export PATH="${HOME}/.nvm/versions/node/v22.19.0/bin:${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin"
AMUX="${AMUX:-${HOME}/.nvm/versions/node/v22.19.0/bin/amux}"
KEEPER_DIR="${HOME}/.agentmux-keeper"
[ -f "${KEEPER_DIR}/OFF" ] && exit 0          # global kill-switch
mkdir -p "$KEEPER_DIR"

now=$(date +%s)
for on in "$KEEPER_DIR"/*.ON; do
  [ -e "$on" ] || continue
  name=$(basename "$on" .ON)
  # shellcheck disable=SC1090
  AGENT=""; PANE=""; REPO=""; TASKFILE=""; LOGFILE=""; STALE_MIN=110
  source "$on"
  [ -n "$AGENT" ] && [ -n "$PANE" ] && [ -n "$REPO" ] || { echo "[$(date -Is)] $name: bad ON-file, skipping"; continue; }

  log_ts=0
  [ -n "$LOGFILE" ] && [ -f "$REPO/$LOGFILE" ] && log_ts=$(stat -c %Y "$REPO/$LOGFILE" 2>/dev/null || echo 0)
  commit_ts=$(git -C "$REPO" log -1 --format=%ct 2>/dev/null || echo 0)
  last=$(( log_ts > commit_ts ? log_ts : commit_ts ))
  age_min=$(( (now - last) / 60 ))

  warn="$KEEPER_DIR/$name.warned"
  if [ "$age_min" -lt "$STALE_MIN" ]; then
    rm -f "$warn"
    echo "[$(date -Is)] $name: OK (senaste framdrift ${age_min}min sedan)"
    continue
  fi

  if [ -f "$warn" ]; then
    "$AMUX" notifyuser --level error "[keeper] $name: ingen framdrift på ${age_min}min trots knuff — behöver mänsklig blick (task: ${TASKFILE:-?})" || true
    echo "[$(date -Is)] $name: ESKALERAD (${age_min}min)"
  else
    touch "$warn"
    echo "[$(date -Is)] $name: NUDGE (${age_min}min)"
  fi
  "$AMUX" "$AGENT" -p "$PANE" "[keeper, automatisk] Ingen framdrift registrerad på ${age_min} min (våg-logg + commits). Om du JOBBAR: fortsätt — men committa nästa gröna delmängd + skriv en rad i ${LOGFILE:-din våg-logg} så vakten ser dig. Om du är FAST: timebox-regeln — checkpointa + ta nästa OBEROENDE item i ${TASKFILE:-din task-fil}. Om HELA kön är KLAR: stäng av din vakt med \`rm ~/.agentmux-keeper/${name}.ON\` och rapportera till api:0." || true
done
