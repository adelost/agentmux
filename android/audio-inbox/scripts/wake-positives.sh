#!/usr/bin/env bash
# Builds the positive set the wake word is held to, into the directory given as $1: someone actually
# saying the phrase and then asking something, in eight locales, clean and over brown noise.
#
# WHY a script: the 48 clips behind wakeword/README.md's 12/12 Swedish voices were never committed, so
# the one number that a stricter detection rule has to be paid against could not be re-run. This rebuilds
# it from a declared table, and `:wakeword:wakePositivesReport` turns it into a count.
#
# WHAT is declared here, and it is NOT the 2026-09-14 set: those clips are gone and edge-tts no longer
# offers the Swedish voices it had. 24 voice-and-pace pairs over eight locales, each rendered clean and
# over brown noise, is 48 clips per phrase. Six of the pairs are Swedish, so twelve clips are Swedish and
# "12 of 12 Swedish voices" keeps its meaning as twelve Swedish clips.
set -euo pipefail
out="${1:?usage: wake-positives.sh <output directory>}"
work="$out/.work"
mkdir -p "$out" "$work"

for tool in ffmpeg edge-tts; do
  command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }
done

# What the speaker asks after the phrase, in their own language: the wake word is English, the question is not.
question_for() {
  case "$1" in
    sv-SE) echo 'hur mycket är klockan?' ;;
    nb-NO) echo 'hva er klokken?' ;;
    da-DK) echo 'hvad er klokken?' ;;
    fi-FI) echo 'paljonko kello on?' ;;
    de-DE) echo 'wie spät ist es?' ;;
    *) echo 'what time is it?' ;;
  esac
}

# voice and pace. Six Swedish pairs, eighteen others, eight locales in all.
PAIRS='
sv-SE-MattiasNeural -15%
sv-SE-MattiasNeural +0%
sv-SE-MattiasNeural +15%
sv-SE-SofieNeural -15%
sv-SE-SofieNeural +0%
sv-SE-SofieNeural +15%
nb-NO-FinnNeural +0%
nb-NO-PernilleNeural +0%
nb-NO-FinnNeural +15%
da-DK-ChristelNeural +0%
da-DK-JeppeNeural +0%
da-DK-ChristelNeural -15%
fi-FI-HarriNeural +0%
fi-FI-NooraNeural +0%
de-DE-KatjaNeural +0%
de-DE-ConradNeural +0%
de-DE-AmalaNeural +15%
en-GB-SoniaNeural +0%
en-GB-RyanNeural +0%
en-GB-LibbyNeural -15%
en-US-AriaNeural +0%
en-US-GuyNeural +0%
en-IN-NeerjaNeural +0%
en-IN-PrabhatNeural +0%
'

# Each phrase's spoken form, exactly as WakePhrases declares it.
PHRASES='
hey-jarvis|Hey Jarvis
hey-marvin|Hey Marvin
alexa|Alexa
'

clips=0
while IFS='|' read -r id spoken; do
  [ -z "$id" ] && continue
  mkdir -p "$out/$id"
  while read -r voice rate; do
    [ -z "$voice" ] && continue
    locale="$(echo "$voice" | cut -d- -f1,2)"
    pace="$(echo "$rate" | tr -d '%+' | tr '-' 'm')"
    stem="$id/${voice}-${pace}"
    text="$spoken, $(question_for "$locale")"
    if [ ! -f "$out/$stem-clean.wav" ]; then
      edge-tts --voice "$voice" --rate="$rate" --text "$text" --write-media "$work/$(basename "$stem").mp3" >/dev/null
      # Speech at -6 dBFS peak: loud and clean, the easy case.
      ffmpeg -nostdin -loglevel error -y -i "$work/$(basename "$stem").mp3" \
        -af "alimiter=limit=0.5" -ac 1 -ar 16000 -c:a pcm_s16le "$out/$stem-clean.wav"
      # The same speech over brown noise at amplitude 0.05, about 20 dB under it: a room, not a studio.
      ffmpeg -nostdin -loglevel error -y -i "$out/$stem-clean.wav" \
        -f lavfi -i "anoisesrc=color=brown:amplitude=0.05:r=16000" \
        -filter_complex "[0:a][1:a]amix=inputs=2:duration=shortest:normalize=0,alimiter=limit=0.8" \
        -ac 1 -ar 16000 -c:a pcm_s16le "$out/$stem-noise.wav"
    fi
    clips=$((clips + 2))
  done <<EOF
$PAIRS
EOF
done <<EOF
$PHRASES
EOF

echo "$clips clips"
for id in hey-jarvis hey-marvin alexa; do
  printf '%-12s %2d clips, %2d of them Swedish\n' "$id" \
    "$(ls "$out/$id" | wc -l)" "$(ls "$out/$id" | grep -c '^sv-SE')"
done
