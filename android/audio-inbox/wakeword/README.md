# wakeword

Android-free, app-agnostic hands-free voice loop: an openWakeWord detector, a
Silero VAD speech probability, the end-of-question policy, the listening loop
that ties them together and a pure phase reducer. A host app supplies a
`WakePcmSource`, maps its own turn model to `TurnProgress` and renders
`WakeStatus`. No Link type is imported here, so the module can move to a shared
kit unchanged, and the loop can be run over recorded audio on a desktop JVM
instead of only on a phone.

The JVM tests run the real models on synthetic edge-tts fixtures: one Swedish
question per offered phrase over brown noise, the weakest measured Swedish
Jarvis voice, and a Swedish sentence without any phrase. Kotlin scores match the
openWakeWord 0.4.0 Python reference (Hey Jarvis 0.9414 vs 0.9414, Hey Marvin
0.99994 vs 0.9999, Alexa 0.9990 vs 0.9986).

## Models

| File | Source | License |
| --- | --- | --- |
| `melspectrogram.onnx`, `embedding_model.onnx` | openWakeWord feature models (Google speech_embedding) | Apache-2.0 |
| `silero_vad.onnx` | Silero VAD v4 as bundled by openWakeWord 0.4.0 | MIT |
| `hey_jarvis_v0.1.onnx`, `hey_marvin_v0.1.onnx`, `alexa_v0.1.onnx` | openWakeWord 0.4.0 pretrained models | CC BY-NC-SA 4.0 (private use) |

A question starts on two chunks in a row at or over the threshold
(`WakeDetectionPolicy`), not on one. Measured 2026-09-19 over 68 minutes of
Swedish broadcast audio, music and Link's own replies with no wake phrase in it,
and over 48 clips per phrase that do say it, both rebuilt by `scripts/` and
described in `docs/qa/2026-09-19-wake-detection-run`:

| Phrase | Swedish clips | All clips | False wakes per hour | Threshold |
| --- | --- | --- | --- | --- |
| Hey Jarvis | 6/12 | 33/48 | 0.00 | 0.4 |
| Hey Marvin | 12/12 | 48/48 | 0.88 | 0.5 |
| Alexa | 12/12 | 46/48 | 0.88 | 0.5 |

## Why Hey Marvin keeps a threshold its false wake clears

Hey Marvin wakes about **0.88 times an hour** on the same corpus, on one telephone
caller whose burst scores 0.77, 0.79 and 0.71 in three chunks running, so no run
length reaches it. Sweeping its threshold at the shipped run of two: 0.50, 0.60,
0.70 and 0.75 all leave that one wake, 0.78 and 0.80 refuse it, and the clip set
stays at 48 of 48 at every point.

It stays at 0.50 anyway, because that last column cannot price the change: the
same clips still give 48 of 48 at a threshold of **0.99**. A set nothing fails
has no marginal examples in it, so it cannot tell 0.78 from 0.50, and a threshold
is the hardest thing to walk back once someone has learned the phrase sometimes
does not work. Hey Marvin is not the default phrase, and its rate is recorded
here rather than traded against a number the evidence cannot support.

The same easy set bounds the other direction too: Hey Jarvis losing **four of 48**
clips to the run of two is a floor on that cost, not a measurement of it, and the
real price is read on a device, where WAKE DEBUG shows a phrase someone actually
said that was over the threshold for one chunk only.

## A known miss

Hey Jarvis does not wake on one of the two Swedish voices the clip set uses.
`sv-SE-SofieNeural` says the phrase six times, clean and over noise, fast, normal
and slow, and the model scores it 0.02, 0.03, 0.04, 0.23, 0.25 and 0.38 against a
threshold of 0.40. Six misses out of six. `sv-SE-MattiasNeural` wakes it all six
times, and Hey Marvin and Alexa wake on both voices every time.

Three of those six are not close to any threshold, so this is the model rather
than a setting. If a person finds that Link never hears them say "Hey Jarvis",
the answer is to choose another phrase in Settings rather than to keep trying.
Hey Jarvis stays the default because with the run of two it is the quiet one in
an hour of radio, and because the phrase is the wearer's to change.

Two earlier numbers this replaces. The 2026-09-14 false-wake column read 0, over
5.9 minutes of synthesised Swedish speech, which is too little audio of one kind
to show a rate of about one per hour. Its 12/12 Swedish column was measured on a
clip set that was never committed and cannot be rebuilt: edge-tts no longer
offers the Swedish voices it had. On the set `scripts/wake-positives.sh` declares,
every Hey Jarvis miss is the one voice `sv-SE-SofieNeural`; see the known miss
above for its six scores. `scripts/wake-corpus.sh`,
`:wakeword:wakeCorpusReport` and `:wakeword:wakePositivesReport` are what measure
all of it now.

Hey Mycroft ships with openWakeWord too but woke on 0 of 12 Swedish voices, so
it is not offered. Alexa also wakes Amazon devices nearby.
