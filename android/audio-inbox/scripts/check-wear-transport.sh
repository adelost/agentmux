#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
phone_build="$root/app/build.gradle.kts"
wear_build="$root/wear/build.gradle.kts"
wear_sources="$root/wear/src/main"

phone_id="$(sed -n 's/.*applicationId = "\(.*\)"/\1/p' "$phone_build" | head -1)"
wear_id="$(sed -n 's/.*applicationId = "\(.*\)"/\1/p' "$wear_build" | head -1)"
if [[ -z "$phone_id" || "$phone_id" != "$wear_id" ]]; then
  echo "Wear transport regression: Data Layer peers need the same application id" >&2
  exit 1
fi

for module in app wear; do
  if ! rg -q 'project\(":link-transport"\)' "$root/$module/build.gradle.kts"; then
    echo "Wear transport regression: $module bypasses the shared mailbox transport" >&2
    exit 1
  fi
  if ! rg -q 'play-services-wearable:' "$root/$module/build.gradle.kts"; then
    echo "Wear transport regression: $module lost its Data Layer client" >&2
    exit 1
  fi
done

if rg -n 'HttpURLConnection|OkHttpClient|openConnection\(' "$wear_sources"; then
  echo "Wear transport regression: Wear must not declare a second HTTP client" >&2
  exit 1
fi

echo "PASS: Phone and Wear share one Data Layer and mailbox transport contract"
