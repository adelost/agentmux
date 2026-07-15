#!/usr/bin/env bash
# Sourceable successful-sweep heartbeat helper for bash cron guards.

_GUARD_HEARTBEAT_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_GUARD_HEARTBEAT_ARMED=0
_GUARD_HEARTBEAT_KEY=""
_GUARD_HEARTBEAT_INTERVAL_SEC=""
_GUARD_HEARTBEAT_METRICS=()

guard_heartbeat_arm() {
  _GUARD_HEARTBEAT_KEY="$1"
  _GUARD_HEARTBEAT_INTERVAL_SEC="$2"
  _GUARD_HEARTBEAT_METRICS=()
  _GUARD_HEARTBEAT_ARMED=1
  trap _guard_heartbeat_on_exit EXIT
}
guard_heartbeat_metric() {
  _GUARD_HEARTBEAT_METRICS+=("$1=$2")
}

guard_heartbeat_disarm() {
  _GUARD_HEARTBEAT_ARMED=0
}

_guard_heartbeat_on_exit() {
  local status=$? node_bin metric
  trap - EXIT
  if [ "$status" -eq 0 ] && [ "${_GUARD_HEARTBEAT_ARMED:-0}" -eq 1 ]; then
    node_bin="${NODE_BIN:-$(command -v node || true)}"
    if [ -z "$node_bin" ]; then
      printf "ERROR %s heartbeat: node executable not found\n" "$_GUARD_HEARTBEAT_KEY" >&2
      status=1
    else
      local -a args=("$_GUARD_HEARTBEAT_SCRIPT_DIR/guard-heartbeat.mjs"
        --key "$_GUARD_HEARTBEAT_KEY" --interval-sec "$_GUARD_HEARTBEAT_INTERVAL_SEC")
      for metric in "${_GUARD_HEARTBEAT_METRICS[@]}"; do args+=(--metric "$metric"); done
      "$node_bin" "${args[@]}" || status=$?
    fi
  fi
  exit "$status"
}
