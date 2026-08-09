#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
main="$root/app/src/main/java/io/agentmux/audioinbox"
wear="$root/wear/src/main/java/io/agentmux/audioinbox/wear"
shared="$root/link-ui/src/main/java/io/agentmux/linkui"
update="$root/link-update-android/src/main/java/io/agentmux/audioinbox/update"

for retired in LinkTheme.kt Timeline.kt UpdateCard.kt; do
  if [[ -e "$main/$retired" ]]; then
    echo "Link UI regression: retired local renderer returned: $retired" >&2
    exit 1
  fi
done

if rg -n \
  'androidx\.compose\.material3|CircularControl|ConversationTimeline|UpdateCard' \
  "$main/LinkPhoneScreen.kt" "$shared/LinkWatchScreen.kt" "$shared/LinkCaptureControl.kt"; then
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
  if rg -n 'io\.v1d\.circlekit:releasekit:|com\.adelost\.releasekit\.(UpdateController|ReleaseSource|ReleaseProductContract)' \
    "$root/$module/build.gradle.kts" "$root/$module/src/main"; then
    echo "Link update regression: $module owns ReleaseKit engine wiring directly" >&2
    exit 1
  fi
done

for retired in "$main/PttDisc.kt" "$wear/WearCaptureScreen.kt"; do
  if [[ -e "$retired" ]]; then
    echo "Link capture regression: host-local PTT renderer returned: $retired" >&2
    exit 1
  fi
done

for module in app wear; do
  if ! rg -q 'project\(":link-ui"\)' "$root/$module/build.gradle.kts"; then
    echo "Link capture regression: $module bypasses the shared Link UI module" >&2
    exit 1
  fi
done
if ! rg -q 'fun LinkCaptureControl\(' "$shared/LinkCaptureControl.kt" ||
   rg -n 'RingPressLifecycle\(' "$main" "$wear"; then
  echo "Link capture regression: Phone/Wear no longer share one PTT lifecycle" >&2
  exit 1
fi
if ! rg -q 'RingActionCueHost' "$main/LinkPhoneScreen.kt" ||
   ! rg -q 'RingActionCueHost' "$wear/WearMainActivity.kt"; then
  echo "Link capture regression: a host lost the shared CircleKit progress surface" >&2
  exit 1
fi

if [[ ! -f "$update/LinkUpdater.kt" ]] ||
  ! rg -q 'io\.v1d\.circlekit:releasekit:' "$root/link-update-android/build.gradle.kts"; then
  echo "Link update regression: the single CircleKit updater adapter is missing" >&2
  exit 1
fi

circlekit_builds=(
  "$root/app/build.gradle.kts"
  "$root/wear/build.gradle.kts"
  "$root/link-ui/build.gradle.kts"
  "$root/link-update-android/build.gradle.kts"
)
required_circlekit_coordinates=(
  "app:designkit"
  "app:ringkit"
  "wear:ringkit"
  "link-ui:designkit"
  "link-ui:ringkit"
  "link-ui:releasekit-ui"
  "link-update-android:releasekit"
)
for declaration in "${required_circlekit_coordinates[@]}"; do
  module="${declaration%%:*}"
  artifact="${declaration##*:}"
  if ! rg -q "io\\.v1d\\.circlekit:$artifact:" "$root/$module/build.gradle.kts"; then
    echo "Link CircleKit regression: $module lost required $artifact" >&2
    exit 1
  fi
done

# The defect this guards (killed in #256) was a Link type that RE-DERIVED what
# ReleaseKit already computes: a `progress: Float` folded out of UpdateProgress,
# plus local version/wire strings for rendering. The guard used to name that
# type, which worked while `UpdatePresentation` and "re-derivation" were the
# same thing. They no longer are: the declared link.update-status contract has
# two fields -- a finite `phase` and the full UpdateState the shared rows
# render -- so a carrier type by that name is now required, and the inspector
# reads it. A name cannot tell the two apart. The shape can.
if rg -n 'toLabelProgress\(|UpdateProgress\.(Determinate|Indeterminate)|progress:\s*Float' \
  "$root/link-core/src" "$shared" "$main"; then
  echo "Link update regression: Link re-derives update progress ReleaseKit already owns" >&2
  exit 1
fi
# Directional half: forbidding derivation is not enough, because a carrier that
# quietly stops carrying UpdateState fails no ban at all. Every Link update
# presentation must hand the shared rows ReleaseKit's own state.
for carrier in $(rg -l 'data class \w*UpdatePresentation' "$root/link-core/src" "$shared" "$main"); do
  if ! rg -q 'data class \w*UpdatePresentation\([^)]*\bupdate:\s*UpdateState' --multiline "$carrier"; then
    echo "Link update regression: $carrier replaces UpdateState instead of carrying it" >&2
    exit 1
  fi
done
if ! rg -q 'releaseUpdateRows\(' "$shared/LinkWatchScreen.kt" ||
   ! rg -q 'releaseUpdateRows\(' "$main/LinkPhoneSettings.kt"; then
  echo "Link update regression: Phone and Watch no longer share releasekit-ui rows" >&2
  exit 1
fi
circlekit_version="$(sed -n 's/^circlekitVersion=//p' "$root/gradle.properties")"
if [[ ! "$circlekit_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Link CircleKit regression: gradle.properties has no valid shared version" >&2
  exit 1
fi
if rg -n 'io\.v1d\.circlekit:[a-z]+:[0-9]+\.[0-9]+\.[0-9]+' "${circlekit_builds[@]}"; then
  echo "Link CircleKit regression: a consumer duplicated the pinned version" >&2
  exit 1
fi
for build in "${circlekit_builds[@]}"; do
  if ! rg -q 'providers\.gradleProperty\("circlekitVersion"\)' "$build"; then
    echo "Link CircleKit regression: $build bypasses the shared pin $circlekit_version" >&2
    exit 1
  fi
done

echo "PASS: Link phone and Wear UI/updater remain CircleKit consumers"
