#!/bin/bash
# Compat wrapper for the bridge's voice transcription. Do not call elsewhere.
# All transcription goes through `transcribe` (see ~/bin/transcribe) —
# the workspace's single STT entry point. One prompt, one model, one place
# to improve. Same pattern as workspace scripts/util/transcribe-whisper.sh.
#
# Backend: Gemini 2.5 Pro. Benchmark 2026-05-27: Whisper-1 misheard tech
# terms ("Gemini"→"Yemeni", "diarization"→"deresation"); Gemini spells
# Swedish + jargon correctly and is cheaper. the operator 2026-07-08: accuracy
# beats latency for voice — never downgrade to flash models.
#
# Usage: transcribe-whisper.sh <audio_file> [language]

AUDIO_FILE="$1"
LANG="${2:-sv}"

if [ -z "$AUDIO_FILE" ]; then
  echo "Usage: $0 <audio_file> [language]" >&2
  exit 1
fi

# Preflight: skip silent clips. STT models hallucinate training-set
# artifacts ("Undertexter från Amara.org") on near-silent audio, and a
# skipped call is a free call. Threshold -75 dB rms = effectively digital
# silence; real Discord voice sits at -53 to -60 dB rms.
# See memory/references/whisper-benchmark.md.
RMS=$(ffmpeg -hide_banner -i "$AUDIO_FILE" -af volumedetect -f null /dev/null 2>&1 \
  | awk '/mean_volume/{print $5}')
if [ -n "$RMS" ]; then
  TOO_QUIET=$(awk -v r="$RMS" 'BEGIN{print (r+0 < -75)}')
  if [ "$TOO_QUIET" = "1" ]; then
    echo "[preflight] silent clip (rms=${RMS}dB), skipping API call" >&2
    exit 0
  fi
fi

# Kedja: gemini (2 försök) → whisper1 (märkt fallback) → ärligt fel.
# Gemini-anrop kan stalla helt (2026-07-11: samma klipp hängde 10+ min i ett
# anrop, tog 13 s i nästa) — därför hårt väggklockstak per försök utöver
# SDK-timeouten inne i transcribe. Fallbacken är ALDRIG tyst: whisper1-text
# prefixas med en markör så mottagaren ser vilken motor som transkriberade
# (whisper1 hör tech-termer sämre än gemini, se benchmark 2026-05-27).
# Lokal faster-whisper är medvetet INTE i kedjan: den är hårdkodad mot delade
# 3090:n (cuda) och en automatisk fallback kan inte invänta GPU-clearance.
# API keys auto-load from ~/.env inside transcribe.

try_backend() { # $1=backend $2=wall-clock-cap $3=clip
  timeout "$2" "$HOME/bin/transcribe" --backend "$1" --stdout --lang "$LANG" "$3"
}

transcribe_clip() {
  local clip="$1" attempt TEXT rc
  for attempt in 1 2; do
    if TEXT=$(try_backend gemini 100s "$clip"); then
      printf '%s\n' "$TEXT"
      return 0
    else
      rc=$?
    fi
    echo "[stt] gemini attempt $attempt/2 failed (exit $rc)" >&2
  done
  if TEXT=$(try_backend whisper1 60s "$clip"); then
    printf '[stt-fallback:whisper1] %s\n' "$TEXT"
    return 0
  fi
  echo "[stt] gemini x2 + whisper1 all failed for $clip" >&2
  return 1
}

# A 110-second voice note repeatedly hit DEADLINE_EXCEEDED; its short
# parts worked, but its first 45-second part still timed out in live testing.
# Use the incident's successful 25-second bound. Server causality is unknown.
# Keep the same transcriber and quality; bound clip duration instead of hiding
# failures behind a larger deadline. Keep Discord Opus compressed, matching the
# successful incident reproduction. Other codecs use independent WAV headers.
DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$AUDIO_FILE") || exit 1
if ! awk -v duration="$DURATION" 'BEGIN { exit !(duration > 45) }'; then
  transcribe_clip "$AUDIO_FILE"
  exit $?
fi

PARTS=$(mktemp -d /tmp/amux-stt.XXXXXX) || exit 1
trap 'rm -rf "$PARTS"' EXIT
CODEC=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$AUDIO_FILE") || exit 1
EXT=wav
CODEC_ARGS=(-c:a pcm_s16le)
if [[ "$CODEC" == opus || "$CODEC" == vorbis ]]; then
  EXT=ogg
  CODEC_ARGS=(-c:a copy)
fi
ffmpeg -nostdin -loglevel error -i "$AUDIO_FILE" -map 0:a:0 -vn "${CODEC_ARGS[@]}" \
  -f segment -segment_time 25 -reset_timestamps 1 "$PARTS/part-%04d.$EXT" || exit 1

pids=()
failed=0
wait_batch() {
  local pid
  for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
  pids=()
}
for clip in "$PARTS"/part-*."$EXT"; do
  [ -f "$clip" ] || { echo "[stt] audio split produced no parts" >&2; exit 1; }
  transcribe_clip "$clip" > "$clip.txt" 2> "$clip.log" &
  pids+=("$!")
  if [ "${#pids[@]}" -eq 3 ]; then wait_batch; fi
done
wait_batch
for log in "$PARTS"/*.log; do cat "$log" >&2; done
[ "$failed" -eq 0 ] || exit 1

fallback=false
joined=""
for result in "$PARTS"/part-*."$EXT".txt; do
  TEXT=$(< "$result")
  if [[ "$TEXT" == '[stt-fallback:whisper1] '* ]]; then
    fallback=true
    TEXT="${TEXT#'[stt-fallback:whisper1] '}"
  fi
  [ -n "$TEXT" ] || { echo "[stt] empty segment transcript" >&2; exit 1; }
  joined="${joined}${joined:+ }${TEXT}"
done
if $fallback; then
  printf '[stt-fallback:whisper1] %s\n' "$joined"
else
  printf '%s\n' "$joined"
fi
