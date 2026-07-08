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

while true; do
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

  # Crash → wait and retry
  echo "[$(date +%H:%M:%S)] crashed (exit $code), restarting in 10s..."
  sleep 10
done
