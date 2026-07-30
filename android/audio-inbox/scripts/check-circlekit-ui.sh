#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
main="$root/app/src/main/java/io/agentmux/audioinbox"
wear="$root/wear/src/main/java/io/agentmux/audioinbox/wear"
update="$root/link-update-android/src/main/java/io/agentmux/audioinbox/update"

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
  if ! rg -q 'project\(":link-update-android"\)' "$root/$module/build.gradle.kts"; then
    echo "Link update regression: $module bypasses the shared Link/CircleKit adapter" >&2
    exit 1
  fi
  if rg -n 'io\.v1d\.circlekit:releasekit:|com\.adelost\.releasekit' \
    "$root/$module/build.gradle.kts" "$root/$module/src/main"; then
    echo "Link update regression: $module owns CircleKit ReleaseKit wiring directly" >&2
    exit 1
  fi
done

if [[ ! -f "$update/LinkUpdater.kt" ]] ||
  ! rg -q 'io\.v1d\.circlekit:releasekit:0\.3\.3' "$root/link-update-android/build.gradle.kts"; then
  echo "Link update regression: the single CircleKit updater adapter is missing" >&2
  exit 1
fi

echo "PASS: Link phone and Wear UI/updater remain CircleKit consumers"
