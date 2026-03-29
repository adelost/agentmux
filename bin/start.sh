#!/usr/bin/env bash
# Agentus supervisor: auto-restart on crash, immediate restart on /restart (exit 75).
# Clean stop: SIGTERM (agent stop agentus) or exit 0.

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
