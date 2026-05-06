#!/bin/bash
# Transcribe audio using OpenAI Whisper API
# Usage: transcribe-whisper.sh <audio_file> [language]

AUDIO_FILE="$1"
LANG="${2:-sv}"

if [ -z "$AUDIO_FILE" ]; then
  echo "Usage: $0 <audio_file> [language]" >&2
  exit 1
fi

# Load key from ~/.env if not set
if [ -z "$OPENAI_API_KEY" ]; then
  [ -f "$HOME/.env" ] && source <(grep OPENAI_API_KEY "$HOME/.env")
fi

if [ -z "$OPENAI_API_KEY" ]; then
  echo "Error: OPENAI_API_KEY not set" >&2
  exit 1
fi

# Preflight: skip silent clips. Whisper-1 hallucinates training-set
# artifacts ("Undertexter från Amara.org") on near-silent audio.
# Threshold -75 dB rms = effectively digital silence; real Discord voice
# sits at -53 to -60 dB rms. See memory/references/whisper-benchmark.md.
RMS=$(ffmpeg -hide_banner -i "$AUDIO_FILE" -af volumedetect -f null /dev/null 2>&1 \
  | awk '/mean_volume/{print $5}')
if [ -n "$RMS" ]; then
  TOO_QUIET=$(awk -v r="$RMS" 'BEGIN{print (r+0 < -75)}')
  if [ "$TOO_QUIET" = "1" ]; then
    echo "[preflight] silent clip (rms=${RMS}dB), skipping API call" >&2
    exit 0
  fi
fi

RESPONSE=$(curl -s "https://api.openai.com/v1/audio/transcriptions" \
  -H "Authorization: Bearer ${OPENAI_API_KEY}" \
  -F "file=@${AUDIO_FILE}" \
  -F "model=whisper-1" \
  -F "language=${LANG}" \
  -F "response_format=text")

echo "$RESPONSE"
