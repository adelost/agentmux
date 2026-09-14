#!/usr/bin/env bash
# Screenshot proof of the hands-free UX without a real microphone.
#
# A debug build of Link plays the WAV through the real wake word detector, VAD
# and end-of-question countdown (WakeWordService's debug WAV source; release
# builds ignore the extra). The phone app must already be installed as a debug
# build, have a recipient selected and be allowed to use the microphone.
#
# Usage: scripts/qa-wake-screens.sh <adb-serial> <clip.wav> <out-dir> [frames]
#   clip.wav  16 kHz mono PCM16, e.g. "Hey Jarvis" + pause + a question
#   PACKAGE   application id of the debug build (default io.agentmux.audioinbox)
# Writes one PNG every ~150 ms named by milliseconds since launch, plus
# sheet.png (the talk ring area of every frame) when ImageMagick is installed.
set -euo pipefail

serial="${1:?adb serial}"
clip="${2:?16 kHz mono wav}"
out="${3:?output directory}"
frames="${4:-40}"
package="${PACKAGE:-io.agentmux.audioinbox}"
export ANDROID_SERIAL="$serial"

mkdir -p "$out"
adb push "$clip" /data/local/tmp/link-wake-qa.wav >/dev/null 2>&1
adb shell "run-as $package sh -c 'mkdir -p cache && cat /data/local/tmp/link-wake-qa.wav > cache/link-wake-qa.wav'"
adb shell am force-stop "$package"
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
started="$(date +%s%3N)"
adb shell am start -n "$package/io.agentmux.audioinbox.MainActivity" \
  --es qa_wake_wav "/data/data/$package/cache/link-wake-qa.wav" >/dev/null
for _ in $(seq 1 "$frames"); do
  adb exec-out screencap -p > "$out/$(printf '%05d' $(( $(date +%s%3N) - started ))).png"
  sleep 0.15
done

if command -v montage >/dev/null; then
  size="$(adb shell wm size | sed -n 's/.*: \([0-9]*\)x\([0-9]*\).*/\1 \2/p')"
  read -r width height <<<"$size"
  tmp="$(mktemp -d)"
  for frame in "$out"/[0-9]*.png; do
    name="$(basename "$frame" .png)"
    convert "$frame" -crop "${width}x$((height * 3 / 10))+0+$((height * 7 / 10))" -resize 300x \
      -gravity North -background black -splice 0x36 -fill white -pointsize 24 -annotate +0+4 "$name ms" "$tmp/$name.png"
  done
  montage "$tmp"/*.png -tile 8x -geometry +3+3 -background '#333' "$out/sheet.png"
  rm -r "$tmp"
fi
echo "$(ls "$out"/[0-9]*.png | wc -l) frames in $out"
