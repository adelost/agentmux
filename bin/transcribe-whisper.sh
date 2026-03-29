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

RESPONSE=$(curl -s "https://api.openai.com/v1/audio/transcriptions" \
  -H "Authorization: Bearer ${OPENAI_API_KEY}" \
  -F "file=@${AUDIO_FILE}" \
  -F "model=whisper-1" \
  -F "language=${LANG}" \
  -F "response_format=text")

echo "$RESPONSE"
