# How often the wake word fires on audio that has no wake word (2026-09-19)

Mattias, 2026-09-19 by voice: it listens for its word "lite väl ofta". This is the measurement that has to
exist before any number in the detector moves. Nothing in this change alters how Link behaves.

The only published rate for the wake word was `wakeword/README.md`: **0 false wakes in 5.9 minutes of
synthesised Swedish speech**. Five point nine minutes cannot show a rate of one per hour, and the audio was
one thing: a text-to-speech voice reading Swedish. This corpus is 68 minutes and six kinds of sound.

## How to run it again

```sh
cd android/audio-inbox
./scripts/wake-corpus.sh /some/corpus            # ~70 MB of audio, never committed
./gradlew :wakeword:wakeCorpusReport -Pcorpus=/some/corpus -Ptraces=/some/traces
```

The report streams the corpus through the real `WakeListeningLoop` with the real models, so the rate it
prints is the loop the phone runs, not a re-implementation of its rule. The loop gained one optional
`WakeChunkTrace`; with it the loop also asks the VAD about every waiting chunk, which is why nothing traces
unless someone asked.

## The corpus

| Source | Minutes | What it is |
| --- | --- | --- |
| `news-ekot-p1` | 20.0 | Ekot, P1: one voice reading the news |
| `talk-nordegren-epstein-p1` | 15.0 | Nordegren & Epstein, P1: two people talking over each other |
| `callin-karlavagnen-p4` | 12.0 | Karlavagnen, P4: callers on a telephone line |
| `music-elektroniskt-p2` | 10.0 | Elektroniskt, P2: electronic music with speech between tracks |
| `tvmix-speech-over-music` | 5.0 | built here: speech in front of a music bed, a room with a TV on |
| `link-own-replies` | 6.0 | built here: 45 of Link's own replies through a phone speaker |
| **Total** | **68.0** | none of it contains a wake phrase, so every detection is a false wake |

`scripts/wake-corpus.sh` rebuilds it. The five broadcast and mixed parts came back **byte for byte identical**
on a second run. `link-own-replies` did not and cannot: edge-tts is a network synthesiser and renders the same
45 sentences a little differently each time. That turns out to matter, below.

## The rate today

Measured on `e3adc40` + this change, 2026-09-19, over the 68 minutes above.

| Phrase | Threshold | Wakes | Per hour | Of the room sent |
| --- | --- | --- | --- | --- |
| Hey Jarvis (the default) | 0.40 | 2 | **1.76** | 35 s |
| Hey Marvin | 0.50 | 1 | 0.88 | 30 s |
| Alexa | 0.50 | 2 | 1.76 | 60 s |

**A false wake is not a beep.** Every one of them opened a question and recorded the room until the endpoint
said the question had ended. In continuous speech that never happens, so the capture ran to its 30 second cap
and the room was uploaded to the agent and answered out loud. Four of the five wakes below cost 30 seconds
each. That is the part of "lite väl ofta" that is not just noise.

## Every wake, with the second before it

Each row is 80 ms. The firing chunk is the last one: after it the loop is capturing and stops tracing.

| Phrase | Source | At | Score | VAD on that chunk | The second before it |
| --- | --- | --- | --- | --- | --- |
| hey-jarvis | link-own-replies | 177.8 s | 0.4700 | 0.96 | 0.00 … 0.00 0.04 0.19 **0.47** |
| hey-jarvis | news-ekot-p1 | 537.7 s | 0.4453 | 1.00 | 0.00 … 0.10 0.34 0.07 0.10 **0.45** |
| hey-marvin | callin-karlavagnen-p4 | 370.5 s | 0.7713 | 0.27 | 0.00 … 0.00 0.01 0.13 **0.77** |
| alexa | callin-karlavagnen-p4 | 104.5 s | 0.9731 | 0.89 | 0.00 … 0.00 0.00 0.22 **0.97** |
| alexa | talk-nordegren-epstein-p1 | 497.5 s | 0.6563 | 0.73 | 0.00 … 0.00 0.03 0.07 **0.66** |

## What the numbers say about the six suspects

**S1, one chunk decides. Supported, and it is the strongest thing in the data.** Every one of the five wakes
is a single chunk spike: the chunk before it scored 0.19, 0.10, 0.13, 0.22 and 0.07, all under the threshold
that the next chunk cleared. A rule of two consecutive chunks at or over the threshold would have refused all
five. It is not free: it delays a real detection by 80 ms and it has to be paid for on the positive clips,
which are measured next and before anything moves.

**S2, no speech gate. Mostly refuted for these wakes.** The VAD called the firing chunk 0.96, 1.00, 0.27, 0.89
and 0.73 speech. A speech floor of 0.5 would have refused one of five, the Karlavagnen Marvin wake. These false
wakes happen *in* speech, not in door slams, so a speech gate is not the lever it looks like from the code.

**S3, Hey Jarvis runs at 0.4 where openWakeWord's default is 0.5. Measured, not acted on.** Both Hey Jarvis
wakes scored 0.4700 and 0.4453, so at 0.5 neither would have fired. What that costs on Swedish voices is not
measured yet, and the threshold is the last thing to move, not the first.

**S4, the detector stays on while Link speaks. Not supported offline; it needs the device.** The single wake
in `link-own-replies` came from a sentence that begins with the word "Hey" ("SUMMARY: Hey, that run is
finished…"), which is half the phrase. Outside the two sentences that start with "Hey", Link's own voice never
scored above **0.072** in 6 minutes. And the same 45 sentences synthesised a second time produced **no wake at
all**, peaking at 0.22. So the corpus cannot decide S4: the phone speaker, the room and the echo canceller are
not in this path. The device trace is what will answer it.

**S5, the icon. Untouched by this measurement**, it is read from the code and belongs to the notification.

**S6, the status already carries the score and the count, and nothing shows them.** True, and the trace this
change adds is the seam the debug page will read.

## What is not measured here, and why it matters

- **The positive side.** The 48-clip set behind the README's 12/12 Swedish voices is not in the repository and
  was not re-run. No rule changes until it is rebuilt the same way, because a rate improved at the cost of
  Swedish voices is not an improvement.
- **The device.** This is the detector's rate on this audio. A phone adds its microphone, its automatic gain
  control and its echo canceller, and the rate there can differ in either direction. The debug trace is built
  so the same numbers can be read on the phone.
- **Mattias's own rooms.** Sixty-eight minutes of Swedish broadcast is a stand-in for a room, not his room.
