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

# API keys auto-load from ~/.env inside transcribe.
exec "$HOME/bin/transcribe" --backend gemini --stdout --lang "$LANG" "$AUDIO_FILE"
