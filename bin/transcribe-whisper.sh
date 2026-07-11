#!/bin/bash
# Compat wrapper for the bridge's voice transcription. Do not call elsewhere.
# All transcription goes through `transcribe` (see ~/bin/transcribe) —
# the workspace's single STT entry point. One prompt, one model, one place
# to improve. Same pattern as workspace scripts/util/transcribe-whisper.sh.
#
# Backend: Gemini 2.5 Pro. Benchmark 2026-05-27: Whisper-1 misheard tech
# terms ("Gemini"→"Yemeni", "diarization"→"deresation"); Gemini spells
# Swedish + jargon correctly and is cheaper. Mattias 2026-07-08: accuracy
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

try_backend() { # $1=backend $2=wall-clock-cap
  timeout "$2" "$HOME/bin/transcribe" --backend "$1" --stdout --lang "$LANG" "$AUDIO_FILE"
}

for attempt in 1 2; do
  if TEXT=$(try_backend gemini 100s); then
    printf '%s\n' "$TEXT"
    exit 0
  fi
  rc=$?
  echo "[stt] gemini attempt $attempt/2 failed (exit $rc)" >&2
done

if TEXT=$(try_backend whisper1 60s); then
  printf '[stt-fallback:whisper1] %s\n' "$TEXT"
  exit 0
fi
echo "[stt] gemini x2 + whisper1 all failed for $AUDIO_FILE" >&2
exit 1
