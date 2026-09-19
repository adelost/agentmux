#!/usr/bin/env bash
# One contact sheet of Link's screens, captured by name rather than by guessed coordinates.
#
# WHY: a layout is judged on glass, not in code. Before anything in Link's UX moves, this takes one
# picture of every screen on one device so the change can be argued against what is there now.
#
# WHAT it does: installs the debug build, drives the app by finding nodes in the UI hierarchy by their
# text and tapping their centre, and writes one PNG per named screen plus a montage when ImageMagick
# is installed. It never taps a coordinate nobody looked up, so a moved row moves the tap with it.
#
# Usage: scripts/qa-contact-sheet.sh <adb-serial> <apk> <out-dir> [wear]
#   The caller owns the emulator and its lock; this script boots nothing and stops nothing.
set -euo pipefail

serial="${1:?adb serial}"
apk="${2:?path to the debug apk}"
out="${3:?output directory}"
flavour="${4:-phone}"
package="${PACKAGE:-io.agentmux.audioinbox}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ANDROID_SERIAL="$serial"

mkdir -p "$out"
shot() { # name
  adb exec-out screencap -p > "$out/$1.png"
  printf '  %-28s %s bytes\n' "$1.png" "$(stat -c%s "$out/$1.png")"
}

# The hierarchy as the device sees it, so a tap lands on what a person would tap.
dump_to() { # file
  adb shell uiautomator dump /sdcard/link-ui.xml >/dev/null 2>&1 || return 1
  adb shell cat /sdcard/link-ui.xml > "$1" 2>/dev/null
  [ -s "$1" ]
}

# Taps the centre of the first node whose text or content-desc contains $1; fails loudly if none.
tap_named() {
  local needle="$1" xml point attempt
  xml="$(mktemp)"
  # A Compose screen can still be settling when the first dump is taken, and a dump of a half-composed
  # tree simply lacks the row. Three reads before giving up, and the tree is kept when it never appears
  # so the failure can be read rather than guessed at.
  for attempt in 1 2 3; do
    if dump_to "$xml"; then
      point="$(python3 "$here/qa-find-node.py" "$xml" "$needle")" || point=""
      [ -n "$point" ] && break
    fi
    sleep 1.5
  done
  if [ -z "$point" ]; then
    cp "$xml" "$out/missing-$(echo "$needle" | tr -c 'A-Za-z0-9' '-').xml" 2>/dev/null || true
    rm -f "$xml"
    echo "no node says '$needle' after three reads; the tree is in $out" >&2
    return 1
  fi
  rm -f "$xml"
  # shellcheck disable=SC2086
  adb shell input tap $point
  sleep 1.2
}

# Whether a node is there at all, without tapping it: used before dismissing a dialog that may not exist.
sees_named() {
  local xml rc=1
  xml="$(mktemp)"
  if dump_to "$xml" && python3 "$here/qa-find-node.py" "$xml" "$1" >/dev/null 2>&1; then rc=0; fi
  rm -f "$xml"
  return $rc
}

echo "installing $apk on $serial"
adb install -r -g "$apk" >/dev/null
# Screen 01 says first run, so it has to be one. An install keeps the app's data, and a preference left on
# by an earlier sheet makes the very first tap miss and every later tap land somewhere nobody looked up.
adb shell pm clear "$package" >/dev/null
# The battery exemption outlives the app's data and is granted for good once anyone says yes, so screen 03
# would quietly stop being the dialog a person meets the first time. Taken back with it.
adb shell dumpsys deviceidle whitelist "-$package" >/dev/null 2>&1 || true
adb shell am force-stop "$package"
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
sleep 1

# 1. First run, before any permission is granted: what a new phone actually shows.
adb shell pm revoke "$package" android.permission.RECORD_AUDIO >/dev/null 2>&1 || true
adb shell pm revoke "$package" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true
adb shell am start -n "$package/io.agentmux.audioinbox.MainActivity" >/dev/null
sleep 3
shot "01-first-run"

adb shell pm grant "$package" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true
adb shell pm grant "$package" android.permission.RECORD_AUDIO >/dev/null 2>&1 || true
adb shell am force-stop "$package"
adb shell am start -n "$package/io.agentmux.audioinbox.MainActivity" >/dev/null
sleep 3
shot "02-main-wake-off"

if [ "$flavour" = "phone" ]; then
  # The wake word on: the same row, now saying where the loop is. Turning it on asks for unrestricted
  # battery use, which is part of what a person meets the first time and so is a screen of its own.
  tap_named "Tap to listen" || echo "the main page has no wake row" >&2
  sleep 2
  shot "03-main-wake-on-battery-ask"
  # The dialog belongs to the system, not to Link, and it swallows every tap behind it. It is also not
  # always there: a phone that already granted the exemption never shows it. So the dialog is looked for
  # before anything is tapped, and BACK is never pressed on a hunch, because on the page itself BACK
  # leaves Link and every screen after it would be of the launcher.
  for _ in 1 2 3; do
    sees_named "run in background" || break
    tap_named "Allow" || tap_named "Deny" || break
    sleep 2
  done
  sleep 2
  shot "04-main-listening"

  tap_named "SETTINGS" || echo "no settings affordance on the main page" >&2
  shot "05-settings-wake-on"

  # WAKE DEBUG, and what it looks like before anyone is watching.
  if tap_named "WAKE DEBUG"; then
    shot "06-wake-debug-idle"
    tap_named "NOT WATCHING" && sleep 2 && shot "06b-wake-debug-watching"
    adb shell input keyevent KEYCODE_BACK; sleep 1
  else
    echo "no WAKE DEBUG row in Settings" >&2
  fi
  adb shell input keyevent KEYCODE_BACK; sleep 1

  # A real near miss through the real detector: a clip of Swedish news whose score reaches 0.4453 on one
  # chunk only, which the shipped rule of two refuses. This is the row the whole device pass is for.
  if [ -n "${QA_WAKE_WAV:-}" ] && [ -f "$QA_WAKE_WAV" ]; then
    adb push "$QA_WAKE_WAV" /data/local/tmp/link-wake-qa.wav >/dev/null
    adb shell "run-as $package sh -c 'mkdir -p cache && cat /data/local/tmp/link-wake-qa.wav > cache/link-wake-qa.wav'"
    adb shell am force-stop "$package"
    adb shell am start -n "$package/io.agentmux.audioinbox.MainActivity" \
      --es qa_wake_wav "/data/data/$package/cache/link-wake-qa.wav" >/dev/null
    sleep 4
    tap_named "Tap to listen" || true
    sleep 14
    shot "07-main-after-near-miss"
    tap_named "SETTINGS" || true
    if tap_named "WAKE DEBUG"; then
      shot "08-wake-debug-refused-run"
      adb shell input keyevent KEYCODE_BACK; sleep 1
    fi
    adb shell input keyevent KEYCODE_BACK; sleep 1
  fi

  # Blocked: the microphone taken away while the preference is on. Nothing is tapped to provoke it any
  # more; the preference stays on, so simply returning to the page is what a wearer does and what he sees.
  adb shell pm revoke "$package" android.permission.RECORD_AUDIO >/dev/null 2>&1 || true
  adb shell am force-stop "$package"
  adb shell am start -n "$package/io.agentmux.audioinbox.MainActivity" >/dev/null
  sleep 3
  shot "09-main-blocked"
  # And the repair the row offers: the tap asks for the permission rather than switching anything off.
  if tap_named "tap to allow"; then
    sleep 2
    shot "09b-main-blocked-tap-asks"
    adb shell input keyevent KEYCODE_BACK; sleep 1
  fi
  tap_named "SETTINGS" || true
  shot "10-settings-blocked"
  adb shell input keyevent KEYCODE_BACK; sleep 1
fi

echo "screens in $out:"
ls "$out"/*.png | sed 's|.*/|  |'

if command -v montage >/dev/null; then
  montage "$out"/*.png -tile 4x -geometry +8+8 -background '#111111' -label '%f' "$out/contact-sheet.png"
  echo "contact sheet: $out/contact-sheet.png"
else
  echo "ImageMagick is not installed, so the single-sheet montage was skipped" >&2
fi
