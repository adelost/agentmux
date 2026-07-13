#!/usr/bin/env bash
# Idempotent install/status/remove/run-once interface for the one-minute poller.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$SCRIPT_DIR/suggestions-comment-bridge-cron.sh"
EXAMPLE="$SCRIPT_DIR/../suggestions-comment-bridge.yaml.example"
CONFIG_PATH="${AMUX_SUGGESTIONS_CONFIG:-$HOME/.config/agent/suggestions-comment-bridge.yaml}"
SCHEDULE="${CRON_SCHEDULE:-* * * * *}"
TAG="# amux-suggestions-comment-bridge"
action="${1:-install}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

ensure_config() {
  if [ -f "$CONFIG_PATH" ]; then return; fi
  mkdir -p "$(dirname "$CONFIG_PATH")"
  install -m 600 "$EXAMPLE" "$CONFIG_PATH"
  printf "Created %s from the reusable example.\n" "$CONFIG_PATH"
}

cron_line() {
  printf "%s AMUX_SUGGESTIONS_CONFIG=%q NODE_BIN=%q %q %s" \
    "$SCHEDULE" "$CONFIG_PATH" "$NODE_BIN" "$WRAPPER" "$TAG"
}

without_ours() {
  crontab -l 2>/dev/null | grep -vF "$TAG" || true
}

case "$action" in
  install|"")
    command -v crontab >/dev/null 2>&1 || { printf "crontab is required\n" >&2; exit 1; }
    command -v flock >/dev/null 2>&1 || { printf "flock is required\n" >&2; exit 1; }
    [ -n "$NODE_BIN" ] || { printf "node is required\n" >&2; exit 1; }
    ensure_config
    chmod +x "$WRAPPER" "$SCRIPT_DIR/suggestions-comment-bridge.mjs"
    line="$(cron_line)"
    current="$(crontab -l 2>/dev/null | grep -F "$TAG" || true)"
    if [ "$current" = "$line" ]; then
      printf "Already installed: %s\n" "$line"
      exit 0
    fi
    { without_ours; printf "%s\n" "$line"; } | crontab -
    printf "Installed: %s\n" "$line"
    printf "Config: %s\n" "$CONFIG_PATH"
    ;;
  status)
    line="$(crontab -l 2>/dev/null | grep -F "$TAG" || true)"
    if [ -z "$line" ]; then
      printf "NOT INSTALLED\n"
      exit 1
    fi
    printf "INSTALLED: %s\n" "$line"
    [ -n "$NODE_BIN" ] || { printf "node is required\n" >&2; exit 1; }
    "$NODE_BIN" "$SCRIPT_DIR/suggestions-comment-bridge.mjs" --config "$CONFIG_PATH" --status
    ;;
  remove|uninstall)
    if ! crontab -l 2>/dev/null | grep -qF "$TAG"; then
      printf "NOT INSTALLED — nothing to remove.\n"
      exit 0
    fi
    without_ours | crontab -
    printf "Removed Suggestions comment bridge cron entry. Config and state were retained.\n"
    ;;
  run-once)
    ensure_config
    AMUX_SUGGESTIONS_CONFIG="$CONFIG_PATH" "$WRAPPER"
    ;;
  *)
    printf "Usage: %s [install|status|remove|run-once]\n" "$0" >&2
    exit 1
    ;;
esac
