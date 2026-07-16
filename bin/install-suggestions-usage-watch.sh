#!/usr/bin/env bash
# Install/status/remove the exact Cloudflare rows-read watcher.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$SCRIPT_DIR/suggestions-usage-watch-cron.sh"
EXAMPLE="$SCRIPT_DIR/../suggestions-usage-watch.yaml.example"
CONFIG_PATH="${AMUX_SUGGESTIONS_USAGE_CONFIG:-$HOME/.config/agent/suggestions-usage-watch.yaml}"
SCHEDULE="${SUGGESTIONS_USAGE_CRON_SCHEDULE:-7,22,37,52 * * * *}"
TAG="# amux-suggestions-usage-watch"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
action="${1:-install}"

ensure_config() {
  if [ -f "$CONFIG_PATH" ]; then return; fi
  mkdir -p "$(dirname "$CONFIG_PATH")"
  install -m 600 "$EXAMPLE" "$CONFIG_PATH"
  printf "Created %s. Set accountId, budget, target and credential before install.\n" "$CONFIG_PATH"
  exit 1
}

cron_line() {
  printf "%s AMUX_SUGGESTIONS_USAGE_CONFIG=%q NODE_BIN=%q %q %s" \
    "$SCHEDULE" "$CONFIG_PATH" "$NODE_BIN" "$WRAPPER" "$TAG"
}

without_ours() { crontab -l 2>/dev/null | grep -vF "$TAG" || true; }

case "$action" in
  install|"")
    command -v crontab >/dev/null 2>&1 || { printf "crontab is required\n" >&2; exit 1; }
    command -v flock >/dev/null 2>&1 || { printf "flock is required\n" >&2; exit 1; }
    [ -n "$NODE_BIN" ] || { printf "node is required\n" >&2; exit 1; }
    ensure_config
    line="$(cron_line)"
    current="$(crontab -l 2>/dev/null | grep -F "$TAG" || true)"
    if [ "$current" = "$line" ]; then printf "Already installed: %s\n" "$line"; exit 0; fi
    { without_ours; printf "%s\n" "$line"; } | crontab -
    printf "Installed: %s\n" "$line"
    ;;
  status)
    line="$(crontab -l 2>/dev/null | grep -F "$TAG" || true)"
    if [ -z "$line" ]; then printf "NOT INSTALLED\n"; exit 1; fi
    printf "INSTALLED: %s\n" "$line"
    ;;
  remove|uninstall)
    without_ours | crontab -
    printf "Removed Suggestions usage watcher. Config and history were retained.\n"
    ;;
  run-once)
    ensure_config
    AMUX_SUGGESTIONS_USAGE_CONFIG="$CONFIG_PATH" "$WRAPPER"
    ;;
  *)
    printf "Usage: %s {install|status|run-once|remove}\n" "$0" >&2
    exit 2
    ;;
esac
