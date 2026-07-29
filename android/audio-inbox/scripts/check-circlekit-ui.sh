#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
main="$root/app/src/main/java/io/agentmux/audioinbox"
wear="$root/wear/src/main/java/io/agentmux/audioinbox/wear"

for retired in LinkTheme.kt Timeline.kt UpdateCard.kt; do
  if [[ -e "$main/$retired" ]]; then
    echo "Link UI regression: retired local renderer returned: $retired" >&2
    exit 1
  fi
done

if rg -n \
  'androidx\.compose\.material3|CircularControl|ConversationTimeline|UpdateCard' \
  "$main/LinkPhoneScreen.kt" "$main/PttDisc.kt" "$wear/WearLinkScreen.kt"; then
  echo "Link UI regression: a product-local Material renderer bypasses CircleKit" >&2
  exit 1
fi

if rg -n 'androidx\.compose\.material3' \
  "$root/app/build.gradle.kts" "$root/wear/build.gradle.kts"; then
  echo "Link UI regression: an app module reintroduced Material3 beside CircleKit" >&2
  exit 1
fi

for module in app wear; do
  if ! rg -q 'io\.v1d\.circlekit:ringkit:' "$root/$module/build.gradle.kts"; then
    echo "Link UI regression: $module no longer consumes CircleKit RingKit" >&2
    exit 1
  fi
done

echo "PASS: Link phone and Wear UI remain CircleKit consumers"
