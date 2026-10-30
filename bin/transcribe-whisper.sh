#!/bin/bash
# Compat wrapper for the bridge's voice transcription. Do not call elsewhere.
# All transcription goes through `transcribe` (see ~/bin/transcribe) —
# the workspace's single STT entry point. One prompt, one model, one place
# to improve. Same pattern as workspace scripts/util/transcribe-whisper.sh.
#
# Backend: api.v1d.io (AMUX_STT_PRIMARY=v1d, the default): Gemini 3.5
# Transcribe with word times, then Haiku proofreads misheard words. Mattias
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

# Keep the existing -75 dB whole-file floor. A fixed -50 dB rule swallowed
# genuine quiet speech in the public dialogue counterexample (2026-10-17).
# Parts also compare with this message's strongest part: at least 30 dB down.
# A peak at -20 dB or above still reaches STT, preserving brief audible sounds.
audio_levels() {
  local levels
  levels=$(ffmpeg -hide_banner -i "$1" -af volumedetect -f null /dev/null 2>&1) || return 1
  awk '/mean_volume/{mean=$5} /max_volume/{peak=$5} END {
    if (mean == "" || peak == "") exit 1
    print mean, peak
  }' <<< "$levels"
}

is_silent() {
  awk -v mean="$1" -v peak="$2" -v strongest="${3:-}" 'BEGIN {
    floor = (mean == "-inf" || mean+0 < -75)
    relative = (strongest != "" && strongest+0 - mean+0 >= 30 && (peak == "-inf" || peak+0 < -20))
    exit !(floor || relative)
  }'
}

range_marker() { # $1=label $2=start $3=end
  printf '[%s %d:%02d–%d:%02d]\n' "$1" "$(($2 / 60))" "$(($2 % 60))" "$(($3 / 60))" "$(($3 % 60))"
}

DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$AUDIO_FILE") || exit 1
TOTAL_SECONDS="${DURATION%.*}"
[[ "$TOTAL_SECONDS" =~ ^[0-9]+$ ]] || { echo "[stt] invalid audio duration" >&2; exit 1; }
LEVELS=$(audio_levels "$AUDIO_FILE") || { echo "[stt] audio level check failed" >&2; exit 1; }
read -r MEAN PEAK <<< "$LEVELS"
if is_silent "$MEAN" "$PEAK"; then
  echo "[preflight] silent clip, skipping API call" >&2
  range_marker tyst 0 "$TOTAL_SECONDS"
  exit 0
fi

# Kedja: gemini → whisper1 (märkt fallback) → ärligt fel. Gemini får ett andra
# försök bara efter ett snabbt fel. Ett försök som körde HUNG_AFTER_S eller
# längre hängde, och samma klipp hängde igen i 5 av 7 andra försök (18-19 okt),
# så whisper1 tar över direkt i stället för att låta klippet hänga en gång till.
# Gemini-anrop kan stalla helt (2026-07-11: samma klipp hängde 10+ min i ett
# anrop, tog 13 s i nästa) — därför hårt väggklockstak per försök utöver
# SDK-timeouten (90 s) inne i transcribe. Fallbacken är ALDRIG tyst: whisper1-text
# prefixas med en markör så mottagaren ser vilken motor som transkriberade
# (whisper1 hör tech-termer sämre än gemini, se benchmark 2026-05-27).
# Lokal faster-whisper är medvetet INTE i kedjan: den är hårdkodad mot delade
# 3090:n (cuda) och en automatisk fallback kan inte invänta GPU-clearance.
# API keys auto-load from ~/.env inside transcribe.

GEMINI_CAP_S="${AMUX_STT_GEMINI_CAP_S:-100}"
HUNG_AFTER_S="${AMUX_STT_HUNG_AFTER_S:-60}"
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

# A backend that answers with no words has heard the clip; the same audio
# gets the same answer, so failing the message only made every retry repeat
# it (2026-10-17). Mark the range instead. Only an unanswered call fails.
transcribe_clip() { # $1=clip $2=start $3=end, in seconds of the whole message
  local clip="$1" attempt TEXT rc started temperature=0 heard_no_words=false tries=2
  local errlog
  # A second API call is a second paid run, and an unknown outcome may already
  # be billed, so the API gets one try and whisper1 takes over after it.
  [ "$PRIMARY" = v1d ] && tries=1
  errlog=$(mktemp) || return 1
  for ((attempt = 1; attempt <= tries; attempt++)); do
    started=$SECONDS
    if TEXT=$(try_primary "$clip" "$temperature" 2> "$errlog"); then
      cat "$errlog" >&2
      if has_words "$TEXT"; then rm -f "$errlog"; printf '%s\n' "$TEXT"; return 0; fi
      heard_no_words=true
      echo "[stt] $PRIMARY attempt $attempt/$tries heard no words" >&2
      continue
    else
      rc=$?
      cat "$errlog" >&2
    fi
    echo "[stt] $PRIMARY attempt $attempt/$tries failed (exit $rc) after $((SECONDS - started)) s" >&2
    log_primary_failure "$attempt" "$rc" "$((SECONDS - started))" "$errlog" "$2" "$3"
    if [ $((SECONDS - started)) -ge "$HUNG_AFTER_S" ]; then
      echo "[stt] $PRIMARY hung; whisper1 takes over now" >&2
      break
    fi
    # Only a fast failure reaches a second try; at temperature 0 the same clip
    # would take the same path again.
    temperature=0.3
  done
  rm -f "$errlog"
  if $heard_no_words; then range_marker ohörbart "$2" "$3"; return 0; fi
  if TEXT=$(try_backend whisper1 60s "$clip"); then
    if has_words "$TEXT"; then printf '[stt-fallback:whisper1] %s\n' "$TEXT"; else range_marker ohörbart "$2" "$3"; fi
    return 0
  fi
  echo "[stt] $PRIMARY x$tries + whisper1 all failed for $clip" >&2
  return 1
}

# A 110-second voice note repeatedly hit DEADLINE_EXCEEDED; its short
# parts worked, but its first 45-second part still timed out in live testing.
# Use the incident's successful 25-second bound. Server causality is unknown.
# Keep the same transcriber and quality; bound clip duration instead of hiding
# failures behind a larger deadline. Keep Discord Opus compressed, matching the
# successful incident reproduction. Other codecs use independent WAV headers.
# That bound is Gemini 2.5 Pro's. The API takes 300 s per call and transcribe
# sends it 240 s parts, so with v1d only a longer message is split.
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

strongest=-1000
for clip in "$PARTS"/part-*."$EXT"; do
  [ -f "$clip" ] || { echo "[stt] audio split produced no parts" >&2; exit 1; }
  LEVELS=$(audio_levels "$clip") || { echo "[stt] segment level check failed" >&2; exit 1; }
  printf '%s\n' "$LEVELS" > "$clip.levels"
  read -r mean peak <<< "$LEVELS"
  strongest=$(awk -v current="$strongest" -v mean="$mean" 'BEGIN { print (mean != "-inf" && mean+0 > current+0) ? mean : current }')
done

pids=()
failed=0
wait_batch() {
  local pid
  for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
  pids=()
}
part_index=0
for clip in "$PARTS"/part-*."$EXT"; do
  [ -f "$clip" ] || { echo "[stt] audio split produced no parts" >&2; exit 1; }
  read -r mean peak < "$clip.levels"
  start=$((part_index * PART_S)); end=$((start + PART_S))
  [ "$end" -le "$TOTAL_SECONDS" ] || end="$TOTAL_SECONDS"
  if is_silent "$mean" "$peak" "$strongest"; then
    range_marker tyst "$start" "$end" > "$clip.txt"
    echo "[preflight] silent segment, skipping API call" >&2
  else
    transcribe_clip "$clip" "$start" "$end" > "$clip.txt" 2> "$clip.log" &
    pids+=("$!")
  fi
  part_index=$((part_index + 1))
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
  [ -n "${TEXT//[[:space:]]/}" ] || { echo "[stt] empty segment transcript" >&2; exit 1; }
  joined="${joined}${joined:+ }${TEXT}"
done
if $fallback; then
  printf '[stt-fallback:whisper1] %s\n' "$joined"
else
  printf '%s\n' "$joined"
fi
