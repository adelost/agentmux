#!/usr/bin/env bash
# agentmux supervisor: auto-restart on crash, immediate restart on /restart (exit 75).
# Clean stop: SIGTERM or exit 0.
#
# Signal contract for restarting the BRIDGE from outside (learned 2026-07-08):
#   kill -9 <node>   -> exit 137 -> crash branch -> RESTART (the only safe kill)
#   kill -TERM <node> -> exit 143 -> break -> whole stack STOPS (by design)
#   kill -INT <node>  -> bash exits too (child-died-of-SIGINT) -> stack DIES
# Prefer /restart in Discord (exit 75) or amux stop && amux serve.

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# Cron/systemd environments lack the user PATH (node lives under nvm here).
# Resolve it in the ONE place that execs node — a watchdog-spawned supervisor
# without this crash-looped on exit 127 every 10s for 23h (2026-07-09).
if ! command -v node >/dev/null 2>&1; then
  nvm_bin="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
  [ -n "$nvm_bin" ] && export PATH="$nvm_bin:$PATH"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[$(date +%H:%M:%S)] FATAL: node not found (PATH=$PATH) — refusing to loop on a missing runtime" >&2
  exit 127
fi

# Give-up backstop: retrying cannot fix a child that dies instantly (missing
# module, syntax error, broken env). Five instant deaths in a row -> stop
# loudly instead of looping forever; the watchdog cron is rate-limited and
# will surface the failure rather than mask it.
fast_crashes=0

while true; do
  started=$(date +%s)
  node index.mjs
  code=$?

  # Clean exit or SIGTERM → stop
  [ "$code" -eq 0 ] && break
  [ "$code" -eq 143 ] && break

  # /restart command → immediate restart
  if [ "$code" -eq 75 ]; then
    echo "[$(date +%H:%M:%S)] restarting (/restart)..."
    sleep 1
    continue
  fi

  # Crash → wait and retry (instant deaths counted toward the backstop)
  if [ $(( $(date +%s) - started )) -lt 5 ]; then
    fast_crashes=$((fast_crashes + 1))
  else
    fast_crashes=0
  fi
  if [ "$fast_crashes" -ge 5 ]; then
    echo "[$(date +%H:%M:%S)] giving up after $fast_crashes consecutive instant crashes (exit $code) — fix the cause, then: amux serve" >&2
    exit 1
  fi
  echo "[$(date +%H:%M:%S)] crashed (exit $code), restarting in 10s..."
  sleep 10
done
