# What a run of two chunks costs, and what it buys (2026-09-19)

Row 209 step 2a. The measurement in `docs/qa/2026-09-19-wake-false-wakes` showed that every false wake in
68 minutes was a single 80 ms chunk whose neighbour scored 0.07 to 0.22, and that document concluded a run
of two would have refused all five. **That conclusion was wrong, and this measurement is what showed it.**
The trace stops the moment the loop starts capturing, so it could show the chunks before a wake and never
the ones after. Three of the five bursts continue above the threshold after the chunk that fired.

Both halves below are measured with the same loop under the same rule, so the two numbers can be put beside
each other: `:wakeword:wakeCorpusReport` and `:wakeword:wakePositivesReport`, both with `-Pdetection=1,2,3`.

## What the rule lengths do

| Phrase | | run 1 | run 2 | run 3 |
| --- | --- | --- | --- | --- |
| Hey Jarvis (the default) | false wakes per hour | 1.76 | **0.00** | **0.00** |
| | clips heard, all / Swedish | 37/48, 6/12 | **33/48, 6/12** | 31/48, 6/12 |
| Hey Marvin | false wakes per hour | 0.88 | **0.88** | **0.88** |
| | clips heard, all / Swedish | 48/48, 12/12 | 48/48, 12/12 | 48/48, 12/12 |
| Alexa | false wakes per hour | 1.76 | 0.88 | **0.00** |
| | clips heard, all / Swedish | 47/48, 12/12 | 46/48, 12/12 | 45/48, 12/12 |

Sixty-eight minutes and five false wakes in all. "0.00 per hour" means no wake in 68 minutes, not never.

**A run of two refuses three of the five, a run of three refuses four.** The fifth is the interesting one.

### The false wake that survives every rule length

Hey Marvin, a caller on a telephone line, 370.5 s into `callin-karlavagnen-p4`. It is not a spike at all:

```
run 1  … 0.00 0.01 0.13 0.77                 fires at 0.7713
run 2  … 0.01 0.13 0.77 0.79                 fires at 0.7914
run 3  … 0.13 0.77 0.79 0.71                 fires at 0.7136
```

Three chunks in a row, a quarter of a second, all far over the 0.50 threshold. The model is confidently
wrong for long enough that asking it twice, or three times, changes nothing. A longer run cannot fix this
class; only the threshold, a refractory time, or something outside the model can.

One thing worth keeping for later: at run 1 the VAD called that firing chunk **0.27** speech, and it is the
only one of the five that a speech floor of 0.5 would have refused. But by the second and third chunk of
the same burst the VAD has risen to 0.67 and 0.66, so a floor read at the chunk that fires only helps while
the rule is one chunk long. The two rules do not simply add up.

### What the run costs the person saying the phrase

For Hey Jarvis, run 2 loses four clips that run 1 heard: `de-DE-AmalaNeural-15-clean` (peak 0.43),
`en-IN-NeerjaNeural-0-clean` (0.66), `fi-FI-NooraNeural-0-clean` (0.72) and `fi-FI-NooraNeural-0-noise`
(0.45). Each had exactly one chunk over the threshold. A 0.72 is not a marginal detection: that is someone
saying the phrase clearly and briskly, and the rule refuses them. No Swedish clip is lost at any run length.

## The positive clips, and an honest break with the old baseline

`wakeword/README.md` recorded 12 of 12 Swedish voices on a 48-clip set that was never committed. That set
is gone, and edge-tts no longer offers the Swedish voices it had: today it offers two.
`scripts/wake-positives.sh` declares a new set of 24 voice-and-pace pairs over eight locales, clean and over
brown noise, 48 clips per phrase, six of the pairs Swedish so twelve clips are Swedish.

It reproduces the old set's "all voices" column almost exactly, which is what makes it comparable:

| Phrase | All voices, 2026-09-14 | All voices, this set | Swedish, 2026-09-14 | Swedish, this set |
| --- | --- | --- | --- | --- |
| Hey Jarvis | 37/48 | **37/48** | 12/12 | **6/12** |
| Hey Marvin | 48/48 | **48/48** | 12/12 | **12/12** |
| Alexa | 45/48 | **47/48** | 12/12 | **12/12** |

**The Swedish column does not come back for Hey Jarvis, and that is a finding rather than a flaw in the
rebuild.** All six misses are the same voice, `sv-SE-SofieNeural`, and all six `sv-SE-MattiasNeural` clips
wake it. Sofie's clean clips peak at 0.025 and 0.035 against a threshold of 0.40, so this is not a threshold
away from working: that voice saying "Hey Jarvis" is not recognised at all. Hey Marvin and Alexa take both
Swedish voices without trouble.

So "Swedish stays 12 of 12" cannot be used as the guard any more. The guard for a rule change is **no loss
against this baseline**, and the baseline is the "this set" column above.

## What I would change, and what I would leave

**Ship the run at two, and do not go to three.** For the default phrase it takes the corpus from 1.76 false
wakes an hour to none, it costs four of 48 clips and no Swedish clip, and it delays a real detection by
80 ms. Three buys only Alexa's second wake and costs two more of the default phrase's clips.

**Do not reach for the threshold yet.** Both Hey Jarvis wakes scored 0.4700 and 0.4453, so 0.50 would refuse
both as well, and it is a smaller change than a run rule. But it would also refuse every clip between 0.40
and 0.50, and the run rule keeps those that have a second chunk behind them. The two want measuring against
each other before either is preferred, which is its own pass.

**The default phrase is the weakest of the three, in both directions.** Hey Jarvis: 1.76 false wakes an hour
and 6 of 12 Swedish clips. Hey Marvin: 0.88 and 12 of 12, at a threshold of 0.50 and with 48 of 48 overall.
Whether the offered default should change is a product decision, not a measurement, so it goes to lsrc:0 and
to Mattias with these numbers rather than being made here.

## How long a real question is, and why the cap cannot decide on its own

lsrc:0's item 3 assumed the local history holds the questions' lengths. It does not, and that is worth
saying before any cap is proposed.

- `LinkTurn` (link-core/LinkState.kt:94) keeps `userText`, `createdAtMs` and `playbackDurationMs`.
  `playbackDurationMs` is the length of the **reply's** audio. Nothing anywhere stores how long the
  **question** was recorded.
- The uploaded question audio is written to a temporary file for transcription and unlinked straight
  after (core/voice-transcriber.mjs:34 and :53), so no recording survives on the server either.
- What does survive is the transcripts. `~/.agentmux/link-connector.json` holds 13 Link turns, 5 of them
  transcribed voice. Their lengths in words: **6, 6, 8, 39, 53**.

So real questions on this machine are mostly short, and two of the five are long. At any plausible Swedish
speaking rate the 53-word one is within reach of the 30 second cap, which is exactly the thing that would
have to be treated as a false wake. Five questions is not a distribution, and a word count is not a
duration.

**What I would do, and what I am not doing.** A capture that hits the cap in continuous speech is a good
signal of a false wake, and in the corpus every false wake that landed in speech ran to the full 30 s. But
the longest real question in the local history is not far below it, so a rule of "discard at the cap"
would sometimes throw away a long dictated question, which is the one case where the wearer loses most.
Nothing is built. The number the cap needs is the distribution of real question lengths, and the cheapest
honest way to get it is the same single listening pass on the device that answers S4: the trace already
sees every capture's length, so one pass gives both.
