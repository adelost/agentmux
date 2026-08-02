#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
properties="$root/gradle.properties"
phone="$root/app/build.gradle.kts"
wear="$root/wear/build.gradle.kts"

version_name="$(sed -n 's/^linkVersionName=//p' "$properties")"
if [[ ! "$version_name" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Link release regression: gradle.properties has no semantic linkVersionName" >&2
  exit 1
fi

for build in "$phone" "$wear"; do
  if ! rg -q 'val linkVersionName = providers\.gradleProperty\("linkVersionName"\)\.get\(\)' "$build" ||
    ! rg -q 'versionName = linkVersionName' "$build"; then
    echo "Link release regression: $build bypasses shared versionName $version_name" >&2
    exit 1
  fi
  if rg -n 'versionName = "[0-9]+\.[0-9]+\.[0-9]+"' "$build"; then
    echo "Link release regression: $build duplicates a visible product version" >&2
    exit 1
  fi
done

phone_code="$(sed -n 's/^[[:space:]]*versionCode = \([0-9][0-9]*\)$/\1/p' "$phone")"
wear_code="$(sed -n 's/^[[:space:]]*versionCode = \([0-9][0-9]*\)$/\1/p' "$wear")"
if [[ ! "$phone_code" =~ ^[0-9]+$ || ! "$wear_code" =~ ^[0-9]+$ ]]; then
  echo "Link release regression: missing monotonic Phone/Wear versionCode" >&2
  exit 1
fi

echo "PASS: Link Phone/Wear versionName=$version_name; codes phone=$phone_code wear=$wear_code"
