#!/usr/bin/env bash
# Install (or remove) the amux todo-remind cron entry.
#
# Default: 08:00 every day → push notification with active todos.
# Override the schedule by setting CRON_SCHEDULE before running:
#   CRON_SCHEDULE="0 8,17 * * *" bin/install-todo-cron.sh
#
# Usage:
#   bin/install-todo-cron.sh          # install
#   bin/install-todo-cron.sh status   # show current crontab line if installed
#   bin/install-todo-cron.sh remove   # uninstall the entry
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$SCRIPT_DIR/todo-remind-cron.sh"
SCHEDULE="${CRON_SCHEDULE:-0 8 * * *}"
TAG="# amux-todo-remind"

if [ ! -x "$WRAPPER" ]; then
  chmod +x "$WRAPPER"
fi

action="${1:-install}"

case "$action" in
  status)
    line="$(crontab -l 2>/dev/null | grep -F "$TAG" || true)"
    if [ -n "$line" ]; then
      printf "INSTALLED: %s\n" "$line"
      exit 0
    fi
    printf "NOT INSTALLED. Run %s install to add the cron entry.\n" "$0"
    exit 1
    ;;

  remove|uninstall)
    if ! crontab -l 2>/dev/null | grep -qF "$TAG"; then
      printf "NOT INSTALLED — nothing to remove.\n"
      exit 0
    fi
    crontab -l 2>/dev/null | grep -vF "$TAG" | crontab -
    printf "Removed amux-todo-remind cron entry.\n"
    exit 0
    ;;

  install|"")
    if crontab -l 2>/dev/null | grep -qF "$TAG"; then
      printf "Already installed:\n"
      crontab -l 2>/dev/null | grep -F "$TAG"
      printf "\nRun %s remove first if you want to change the schedule.\n" "$0"
      exit 0
    fi
    {
      crontab -l 2>/dev/null || true
      printf "%s %s %s\n" "$SCHEDULE" "$WRAPPER" "$TAG"
    } | crontab -
    printf "Installed cron entry:\n  %s %s\n" "$SCHEDULE" "$WRAPPER"
    printf "Logs → ~/agentmux-todo-remind.log\n"
    ;;

  *)
    printf "Usage: %s [install|status|remove]\n" "$0" >&2
    exit 1
    ;;
esac
