#!/usr/bin/env bash
# Builds the negative corpus the wake word is measured against, into the directory given as $1.
#
# WHY a script and not fixtures: the corpus is an hour of broadcast audio. It is far too large to commit
# and it is not ours to redistribute, so the recipe is what the repository keeps. Everyone who runs this
# gets the same hour, and `:wakeword:wakeCorpusReport` turns it into a rate.
#
# WHAT is in it (Mattias 2026-09-19 reports the wake word fires "lite väl ofta"; the only published number
# for it was 5.9 minutes of synthesised Swedish speech, which cannot show one false wake per hour):
#   20 min  Swedish news read by one voice            Ekot, P1
#   15 min  two people talking over each other        Nordegren & Epstein, P1
#   12 min  callers on a telephone line               Karlavagnen, P4
#   10 min  electronic music with speech between      Elektroniskt, P2
#    5 min  speech over a music bed, a room with a TV  built here from two of the above programmes
#    6 min  Link's own replies through a phone speaker built here with the server's own synthesiser
# None of it contains a wake phrase, so every detection is a false wake.
set -euo pipefail
out="${1:?usage: wake-corpus.sh <output directory>}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$out/.work"
mkdir -p "$out" "$work"

for tool in ffmpeg ffprobe edge-tts; do
  command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }
done

# 16 kHz mono 16-bit: the exact format the detector consumes, so nothing is resampled later.
cut() { # url start-seconds seconds name
  [ -f "$out/$4.wav" ] && return 0
  ffmpeg -nostdin -loglevel error -y -ss "$2" -i "$1" -t "$3" -ac 1 -ar 16000 -c:a pcm_s16le "$out/$4.wav"
}

EKOT='https://static-cdn.sr.se/laddahem/ljudit/p1/ekot_1230/2026/09/ekot_nyhetssandning_ekot_1230_gronlandsavtal_med_20260919_1256179859.mp3'
EPSTEIN='https://static-cdn.sr.se/laddahem/podradio/p1_epstein/2021/08/p1_epstein_20210825_1504_612673d1.mp3'
KARLAVAGNEN='https://static-cdn.sr.se/laddahem/podradio/p4_karlavagnen/2021/08/p4_karlavagnen_20210825_2103_6126ddc4.mp3'
ELEKTRONISKT='https://static-cdn.sr.se/laddahem/podradio/p2_elektroniskt/2021/08/p2_elektroniskt_20210820_0800_611b70c9.mp3'
MORGONPASSET='https://static-cdn.sr.se/laddahem/podradio/p3_morgonpasset/2021/08/p3_morgonpasset_20210825_0630_61262217.mp3'

cut "$EKOT" 0 1200 news-ekot-p1
cut "$EPSTEIN" 120 900 talk-nordegren-epstein-p1
cut "$KARLAVAGNEN" 300 720 callin-karlavagnen-p4
cut "$ELEKTRONISKT" 180 600 music-elektroniskt-p2

# A room with a television on: one programme's speech in front, another's music behind it.
if [ ! -f "$out/tvmix-speech-over-music.wav" ]; then
  ffmpeg -nostdin -loglevel error -y -ss 600 -i "$MORGONPASSET" -t 300 -ac 1 -ar 16000 -c:a pcm_s16le "$work/tv-speech.wav"
  ffmpeg -nostdin -loglevel error -y -ss 1200 -i "$ELEKTRONISKT" -t 300 -ac 1 -ar 16000 -c:a pcm_s16le "$work/tv-music.wav"
  ffmpeg -nostdin -loglevel error -y -i "$work/tv-speech.wav" -i "$work/tv-music.wav" \
    -filter_complex "[0:a]volume=1.0[s];[1:a]volume=0.32[m];[s][m]amix=inputs=2:duration=shortest:normalize=0,alimiter=limit=0.8" \
    -ac 1 -ar 16000 -c:a pcm_s16le "$out/tvmix-speech-over-music.wav"
fi

# Link answering out loud, as its own microphone hears it: the detector keeps running while Link speaks
# (WakeSession.listensForWakeWord), so Link's voice is one of the sounds that can wake it.
# Same synthesiser as the server's POST /api/tts, and the same default voice (core/runtime-defaults.mjs).
# The speaker is small and loud: no bass, rolled-off treble, compressed, one short room reflection.
if [ ! -f "$out/link-own-replies.wav" ]; then
  : > "$work/replies.txt"
  n=0
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue;; esac
    n=$((n + 1))
    case "$line" in *[åäöÅÄÖ]*) voice='sv-SE-MattiasNeural';; *) voice='en-US-AriaNeural';; esac
    [ -f "$work/reply-$n.mp3" ] || edge-tts --voice "$voice" --text "$line" --write-media "$work/reply-$n.mp3" >/dev/null
    ffmpeg -nostdin -loglevel error -y -i "$work/reply-$n.mp3" \
      -af "highpass=f=400,lowpass=f=7500,acompressor=threshold=-18dB:ratio=4:attack=5:release=120,aecho=0.6:0.5:40|75:0.25|0.15,alimiter=limit=0.5" \
      -ac 1 -ar 16000 -c:a pcm_s16le "$work/reply-$n.wav"
    ffmpeg -nostdin -loglevel error -y -f lavfi -t 2 -i "anoisesrc=color=pink:amplitude=0.002:r=16000" \
      -ac 1 -ar 16000 -c:a pcm_s16le "$work/gap-$n.wav"
    printf "file '%s'\nfile '%s'\n" "$work/gap-$n.wav" "$work/reply-$n.wav" >> "$work/replies.txt"
  done < "$here/wake-corpus-replies.txt"
  ffmpeg -nostdin -loglevel error -y -f concat -safe 0 -i "$work/replies.txt" -ac 1 -ar 16000 -c:a pcm_s16le "$out/link-own-replies.wav"
fi

total=0
for f in "$out"/*.wav; do
  seconds="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")"
  printf '%-34s %6.1f min\n' "$(basename "$f")" "$(awk "BEGIN{print $seconds/60}")"
  total="$(awk "BEGIN{print $total + $seconds}")"
done
printf '%-34s %6.1f min\n' TOTAL "$(awk "BEGIN{print $total/60}")"
