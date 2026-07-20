#!/usr/bin/env python3
"""Offline Windows voice-note transcription for the rescue manager."""

import argparse
import sys

from faster_whisper import WhisperModel


def main() -> int:
    """WHAT: Builds one local voice-note transcription. WHY: Keeps rescue speech independent from WSL and network model downloads."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("audio")
    args = parser.parse_args()
    model = WhisperModel(args.model, device="cpu", compute_type="int8", local_files_only=True)
    segments, _ = model.transcribe(args.audio, language="sv", vad_filter=True, beam_size=1)
    transcript = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
    if not transcript:
        print("transcription-empty", file=sys.stderr)
        return 2
    print(transcript)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
