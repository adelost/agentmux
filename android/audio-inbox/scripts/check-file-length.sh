#!/usr/bin/env bash
# Manual, module-derived production-file length ratchet for Agentmux Link.
#
# This tool is intentionally not connected to Gradle, git hooks, release, or
# hosted CI. New Kotlin/Java production files may never exceed 500 lines.
# Audited pre-existing exceptions, if any, live in the shrink-only baseline.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BASELINE_FILE="$SCRIPT_DIR/file-length-baseline.txt"
SETTINGS_FILE="$ANDROID_ROOT/settings.gradle.kts"
MAX=500

if [[ ! -f "$BASELINE_FILE" || ! -f "$SETTINGS_FILE" ]]; then
  echo "check-file-length: baseline or settings.gradle.kts is missing" >&2
  exit 2
fi

declare -a modules=()
while IFS= read -r line; do
  [[ "$line" =~ ^[[:space:]]*include\( ]] || continue
  remainder="$line"
  while [[ "$remainder" =~ \"(:[^\"]+)\" ]]; do
    match="${BASH_REMATCH[1]}"
    path="${match#:}"
    modules+=("${path//:/\/}")
    remainder="${remainder#*\"$match\"}"
  done
done < "$SETTINGS_FILE"

if [[ "${#modules[@]}" -eq 0 ]]; then
  echo "check-file-length: no Gradle modules parsed; refusing a false green" >&2
  exit 2
fi

declare -A declared=()
declare -A baselined=()
declare -a scan_roots=()
for module in "${modules[@]}"; do
  declared["$module"]=1
  if [[ ! -d "$ANDROID_ROOT/$module" ]]; then
    echo "check-file-length: declared module is missing: $module" >&2
    exit 2
  fi
  scan_roots+=("$ANDROID_ROOT/$module")
done

fail=0
while read -r path lines owner extra; do
  [[ -z "${path:-}" || "$path" == \#* ]] && continue
  if [[ -z "${owner:-}" || -n "${extra:-}" || ! "$lines" =~ ^[0-9]+$ ]]; then
    echo "FAIL malformed baseline row: $path ${lines:-} ${owner:-} ${extra:-}"
    fail=1
    continue
  fi
  baselined["$path"]="$lines"
  file="$ANDROID_ROOT/$path"
  if [[ ! -f "$file" ]]; then
    echo "FAIL missing baselined file: $path"
    fail=1
    continue
  fi
  actual="$(wc -l < "$file")"
  if (( actual > lines )); then
    echo "FAIL $path grew: $actual > $lines (owner $owner)"
    fail=1
  elif (( actual <= MAX )); then
    echo "FAIL $path is now $actual lines; delete its baseline row"
    fail=1
  elif (( actual < lines )); then
    echo "FAIL $path shrank: lower its baseline from $lines to $actual"
    fail=1
  fi
done < "$BASELINE_FILE"

while IFS= read -r file; do
  relative="${file#"$ANDROID_ROOT/"}"
  [[ -n "${baselined[$relative]:-}" ]] && continue
  actual="$(wc -l < "$file")"
  if (( actual > MAX )); then
    echo "FAIL new production file exceeds $MAX lines: $relative ($actual)"
    fail=1
  fi
done < <(
  find "${scan_roots[@]}" -path '*/src/main/*' -type f \
    \( -name '*.kt' -o -name '*.java' \) | sort
)

while IFS= read -r main_dir; do
  module="${main_dir#"$ANDROID_ROOT/"}"
  module="${module%/src/main}"
  if [[ -z "${declared[$module]:-}" ]]; then
    echo "FAIL undeclared production source tree: $module/src/main"
    fail=1
  fi
done < <(
  find "$ANDROID_ROOT" \
    -type d \( -name build -o -name .git -o -name .gradle \) -prune -o \
    -type d -path '*/src/main' -print | sort
)

if (( fail != 0 )); then
  exit 1
fi
echo "PASS: ${#modules[@]} Link modules have no production Kotlin/Java file over $MAX lines"
