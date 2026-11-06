#!/bin/bash
# Compat wrapper for the bridge's voice transcription. Do not call elsewhere.
# All transcription goes through `transcribe` (see ~/bin/transcribe) —
# the workspace's single STT entry point. One prompt, one model, one place
# to improve. Same pattern as workspace scripts/util/transcribe-whisper.sh.
#
# Backend: api.v1d.io (AMUX_STT_PRIMARY=v1d, the default): transcribe hears
# with tidy on the default route (Gemini 3.1 Flash-Lite) in 19 s parts. When
# the bridge sets V1D_CONTEXT (the target pane's latest reply), transcribe then
# spells the heard words against it with /v1/proofread, 2 to 4 s and about
# 0.0006 USD more per part (ai:1 1 Nov). Mattias
# 2026-10-30 chose the API over Gemini 2.5 Pro after using it. The Pro chain
# stays behind AMUX_STT_PRIMARY=gemini as the way back. Benchmark 2026-05-27:
# Whisper-1 mishears tech terms ("Gemini"→"Yemeni"), so it is only the fallback.
#
# Usage: transcribe-whisper.sh <audio_file> [language]

AUDIO_FILE="$1"
LANG="${2:-sv}"

if [ -z "$AUDIO_FILE" ]; then
  echo "Usage: $0 <audio_file> [language]" >&2
  exit 1
fi

range_marker() { # $1=label $2=start $3=end
  printf '[%s %d:%02d–%d:%02d]\n' "$1" "$(($2 / 60))" "$(($2 % 60))" "$(($3 / 60))" "$(($3 % 60))"
}

DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$AUDIO_FILE") || exit 1
TOTAL_SECONDS="${DURATION%.*}"
[[ "$TOTAL_SECONDS" =~ ^[0-9]+$ ]] || { echo "[stt] invalid audio duration" >&2; exit 1; }
# One primary attempt. A verified unavailable admission may use Whisper once,
# after CPU VAD; a timeout, UNKNOWN, refusal or empty answer never resends audio.
# Keys load inside transcribe. No GPU or local ASR is used by this wrapper. CPU VAD precedes every call.
GEMINI_CAP_S="${AMUX_STT_GEMINI_CAP_S:-100}"
# A clip of at most 45 s needs about 400 answer tokens, so a thinking or
# repetition loop stops at these caps instead of running on to the deadline.
GEMINI_LIMITS=(--thinking-budget 1024 --max-output-tokens 2048)
PRIMARY="${AMUX_STT_PRIMARY:-v1d}"
case "$PRIMARY" in
  v1d|gemini) ;;
  *) echo "[stt] unknown AMUX_STT_PRIMARY: $PRIMARY (use v1d or gemini)" >&2; exit 2 ;;
esac
# The API answers a 240 s part in seconds; the cap only bounds a stalled call.
V1D_CAP_S="${AMUX_STT_V1D_CAP_S:-150}"
STT_FAILURE_LOG="$HOME/.agentmux/stt-$PRIMARY-failures.jsonl"

try_backend() { # $1=backend $2=wall-clock-cap $3=clip, then extra transcribe options
  local backend="$1" cap="$2" clip="$3"
  shift 3
  timeout "$cap" "$HOME/bin/transcribe" --backend "$backend" --stdout --lang "$LANG" "$@" "$clip"
}

try_primary() { # $1=clip $2=temperature (gemini only)
  if [ "$PRIMARY" = v1d ]; then
    try_backend v1d "${V1D_CAP_S}s" "$1"
  else
    try_backend gemini "${GEMINI_CAP_S}s" "$1" "${GEMINI_LIMITS[@]}" --temperature "$2"
  fi
}

# One line per failed primary try, so a clip that whisper1 rescued still says
# why the primary failed. The reason is the provider's error line, never the words.
log_primary_failure() { # $1=attempt $2=exit $3=seconds $4=stderr-file $5=start $6=end
  mkdir -p "${STT_FAILURE_LOG%/*}" && (umask 077; python3 -I - "$@" "$AUDIO_FILE" "$PRIMARY" >> "$STT_FAILURE_LOG") <<'PY' \
    || echo "[stt] could not log the $PRIMARY failure to $STT_FAILURE_LOG" >&2
import json, re, sys, time
attempt, rc, seconds, errfile, start, end, audio, backend = sys.argv[1:9]
lines = [line.strip() for line in open(errfile, encoding="utf-8", errors="replace") if line.strip()]
errors = [line for line in lines if re.search(r"Error|Exception|DEADLINE|UNAVAILABLE|MAX_TOKENS|[Tt]imeout|^v1d ", line)]
reason = (errors or lines or [f"wall-clock cap after {seconds} s" if rc == "124" else "no error text"])[-1]
print(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "audio": audio,
                  "range": [int(start), int(end)], "attempt": int(attempt), "backend": backend,
                  "exit": int(rc), "seconds": int(seconds), "reason": reason[:300]}, ensure_ascii=False))
PY
}

has_words() { [ -n "${1//[[:space:]]/}" ]; }

# Keep the VAD inside this pinned helper: the bridge copies only this file.
has_speech() {
  python3 - "$1" <<'PYVAD'
import sys
import numpy as np
from faster_whisper.audio import decode_audio
from faster_whisper.vad import VadOptions, get_speech_timestamps

audio = decode_audio(sys.argv[1], sampling_rate=16000)
peak = float(np.max(np.abs(audio))) if audio.size else 0
if not peak:
    sys.exit(20)
audio = audio * (0.9 / peak)
speech = get_speech_timestamps(audio, VadOptions(min_speech_duration_ms=0,
                                              min_silence_duration_ms=100,
                                              speech_pad_ms=0))
sys.exit(0 if speech else 20)
PYVAD
}

# Empty/typed no-speech is an answer. UNKNOWN may already be paid: never
# resend it to another provider. Exit 21 alone proves primary unavailable.
transcribe_clip() { # $1=clip $2=start $3=end
  local clip="$1" TEXT rc errlog started
  # An RMS/peak test cannot distinguish noise from speech. Silero runs on CPU
  # and normalizes relative amplitude, preserving short and quiet utterances.
  if has_speech "$clip"; then :; else
    rc=$?
    if [ "$rc" -eq 20 ]; then echo '[stt:no_speech]'; return 0; fi
    echo '[stt] speech detection unavailable; refusing transcription' >&2
    return "$rc"
  fi
  errlog=$(mktemp) || return 1
  started=$SECONDS
  if TEXT=$(try_primary "$clip" 0 2> "$errlog"); then
    cat "$errlog" >&2; rm -f "$errlog"
    if has_words "$TEXT"; then printf '%s\n' "$TEXT"; else echo '[stt:no_speech]'; fi
    return 0
  else
    rc=$?
  fi
  cat "$errlog" >&2
  log_primary_failure 1 "$rc" "$((SECONDS - started))" "$errlog" "$2" "$3"
  rm -f "$errlog"
  if [ "$rc" -eq 20 ]; then echo '[stt:no_speech]'; return 0; fi
  if [ "$rc" -eq 23 ]; then return 23; fi
  if [ "$rc" -ne 21 ]; then
    echo '[stt] primary outcome is not verified unavailable; no fallback' >&2
    return 22
  fi
  echo '[stt] primary unavailable; using Whisper after speech detection' >&2
  if TEXT=$(try_backend whisper1 60s "$clip"); then
    if has_words "$TEXT"; then printf '[stt-fallback:whisper1] %s\n' "$TEXT"; else echo '[stt:no_speech]'; fi
    return 0
  fi
  echo '[stt] Whisper outcome unknown; no retry' >&2
  return 22
}

# A 110-second voice note repeatedly hit DEADLINE_EXCEEDED; its short
# parts worked, but its first 45-second part still timed out in live testing.
# Use the incident's successful 25-second bound. Server causality is unknown.
# Keep the same transcriber and quality; bound clip duration instead of hiding
# failures behind a larger deadline. Keep Discord Opus compressed, matching the
# successful incident reproduction. Other codecs use independent WAV headers.
# That bound is Gemini 2.5 Pro's. With v1d, transcribe cuts the API's parts
# itself, so only a message over 240 s is split here.
if [ "$PRIMARY" = v1d ]; then SPLIT_ABOVE_S=240 PART_S=240; else SPLIT_ABOVE_S=45 PART_S=25; fi
if ! awk -v duration="$DURATION" -v above="$SPLIT_ABOVE_S" 'BEGIN { exit !(duration > above) }'; then
  transcribe_clip "$AUDIO_FILE" 0 "$TOTAL_SECONDS"
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
  -f segment -segment_time "$PART_S" -reset_timestamps 1 "$PARTS/part-%04d.$EXT" || exit 1

pids=()
failed=0
wait_batch() {
  local pid rc
  for pid in "${pids[@]}"; do
    if wait "$pid"; then :; else
      rc=$?
      if [ "$rc" -eq 22 ] || [ "$failed" -eq 0 ] || { [ "$rc" -eq 23 ] && [ "$failed" -ne 22 ]; }; then failed=$rc; fi
    fi
  done
  pids=()
}
part_index=0
for clip in "$PARTS"/part-*."$EXT"; do
  [ -f "$clip" ] || { echo "[stt] audio split produced no parts" >&2; exit 1; }
  start=$((part_index * PART_S)); end=$((start + PART_S))
  [ "$end" -le "$TOTAL_SECONDS" ] || end="$TOTAL_SECONDS"
  transcribe_clip "$clip" "$start" "$end" > "$clip.txt" 2> "$clip.log" &
  pids+=("$!")
  part_index=$((part_index + 1))
  if [ "${#pids[@]}" -eq 3 ]; then wait_batch; fi
done
wait_batch
for log in "$PARTS"/*.log; do cat "$log" >&2; done
[ "$failed" -eq 0 ] || exit "$failed"

fallback=false
joined=""
for result in "$PARTS"/part-*."$EXT".txt; do
  TEXT=$(< "$result")
  if [[ "$TEXT" == '[stt-fallback:whisper1] '* ]]; then
    fallback=true
    TEXT="${TEXT#'[stt-fallback:whisper1] '}"
  fi
  [[ "$TEXT" == "[stt:no_speech]" || "$TEXT" == '[tyst '* ]] && continue
  [ -n "${TEXT//[[:space:]]/}" ] || { echo "[stt] empty segment transcript" >&2; exit 1; }
  joined="${joined}${joined:+ }${TEXT}"
done
if [ -z "$joined" ]; then
  echo '[stt:no_speech]'
elif $fallback; then
  printf '[stt-fallback:whisper1] %s\n' "$joined"
else
  printf '%s\n' "$joined"
fi
