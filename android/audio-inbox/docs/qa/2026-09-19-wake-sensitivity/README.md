# What each sensitivity step buys and costs (2026-09-19)

Row 209 step 5b. Mattias asked whether the wake word should have "en viss känslighet man kunde tune in",
the way the OpenClaw assistant had. It ships as three steps with a word each, STRICT, NORMAL and EAGER,
rather than a confidence slider: OpenClaw's slider is the raw threshold, so it runs backwards to its own
name, higher meaning less sensitive.

A step is a rule and an offset from the phrase's own measured threshold, which stays the anchor. The two
numbers here are the offsets, and this document is where they come from. Everything is measured with the
same loop and the same two reports as the run rule, `:wakeword:wakeCorpusReport` over 68 minutes of Swedish
broadcast audio with no phrase in it and `:wakeword:wakePositivesReport` over 48 clips per phrase that say
it, both rebuilt by `scripts/`.

## Every row measured

False wakes per hour over the 68 minutes, then clips heard, all of 48 and the Swedish 12 of them.

| Phrase | | EAGER −0.10 | −0.05 | NORMAL | run 3 alone | STRICT +0.05 | +0.10 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Hey Jarvis (the default) | threshold, run | 0.30, 2 | 0.35, 2 | **0.40, 2** | 0.40, 3 | **0.45, 3** | 0.50, 3 |
| | false wakes per hour | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| | clips heard | **35/48, 7/12** | 33/48, 6/12 | 33/48, 6/12 | 31/48, 6/12 | 31/48, 6/12 | 31/48, 6/12 |
| Hey Marvin | threshold, run | 0.40, 2 | 0.45, 2 | **0.50, 2** | 0.50, 3 | **0.55, 3** | 0.60, 3 |
| | false wakes per hour | 0.88 | 0.88 | 0.88 | 0.88 | 0.88 | 0.88 |
| | clips heard | 48/48, 12/12 | 48/48, 12/12 | 48/48, 12/12 | 48/48, 12/12 | 48/48, 12/12 | 48/48, 12/12 |
| Alexa | threshold, run | 0.40, 2 | 0.45, 2 | **0.50, 2** | 0.50, 3 | **0.55, 3** | 0.60, 3 |
| | false wakes per hour | 0.88 | 0.88 | 0.88 | 0.00 | 0.00 | 0.00 |
| | clips heard | 46/48, 12/12 | 46/48, 12/12 | 46/48, 12/12 | 45/48, 12/12 | 44/48, 12/12 | 44/48, 12/12 |

The shipped steps are in bold. "0.00 per hour" means no wake in 68 minutes, not never.

## EAGER is −0.10, and it is the only step that gains anything

At −0.10 Hey Jarvis wakes on **35 of 48 clips instead of 33, and on 7 of 12 Swedish instead of 6**, without
a single false wake gained on any of the three phrases. The recovered Swedish clip is one of the six
`sv-SE-SofieNeural` says, the voice the README records as a known miss: its best score is 0.38 against a
threshold of 0.40, and at 0.30 it is finally heard. That is exactly the person EAGER exists for.

At −0.05 Hey Jarvis wakes on the same 33 clips as NORMAL. A step that changes nothing is worse than no
step, so −0.05 is not what ships. Nothing beyond −0.10 was measured, so nothing beyond it is offered.

On this corpus EAGER beats NORMAL on the default phrase in both columns at once, the same 0.00 an hour and
two more clips, which is an argument for moving the default rather than for a setting. The default does not
move, for the same reason the corpus cannot price STRICT's margin: 68 minutes with no Hey Jarvis wake in it
cannot tell 0.30 apart from 0.40, and a lower threshold can only ever produce more wakes in a room this
recording does not contain. NORMAL is where each phrase was measured, and it stays the default until a room
says otherwise. That is also why its one sentence on screen says what it is rather than that it is best.

## STRICT is its run of three; its margin is undecided offline

Every false wake STRICT removes on this corpus is removed by the run of three alone: Alexa goes from 0.88
an hour to zero at +0.00, and the two margins change nothing after that. Hey Marvin's one wake survives
every threshold up to +0.10 and every run length, because it is not a spike; that caller's burst scores
0.77, 0.79 and 0.71 in three chunks running.

So the margin's only measured effect is a cost: **one Alexa clip, 45 of 48 becoming 44**. It is kept at
+0.05 anyway, for one reason that the corpus cannot test. A wearer only reaches for STRICT because his room
wakes Link more often than this corpus does, and once the run of three is spent, the threshold is the only
lever left; a higher threshold can never produce more wakes than a lower one. Sixty-eight minutes of radio
holding one false wake that nothing refuses has no resolution to price that lever either way.

**This is the number the device pass decides.** If Mattias's room wakes Link and STRICT does not stop it,
the margin is doing nothing for him and should go to +0.00, which costs one Alexa clip less. WAKE DEBUG
names the step on every refused run, so that pass reads the answer directly off the page.

## What the tests pin

`WakeSensitivityTest` holds each step to what it does to the loop rather than to its number, on the same
WAV fixtures the detector is held to:

- every step still wakes on a Swedish voice over noise, so no step costs the phrase itself
- no step wakes on a Swedish sentence without the phrase
- no step lets one chunk decide, which is the shape every false wake in the corpus had
- EAGER hears 0.38, NORMAL refuses it, NORMAL hears 0.42 and STRICT refuses it
- a step moves every phrase by the same amount from its own anchor, never replacing it

Each of the two margins and STRICT's run of three was mutated back to the shipped default and the tests
went red on it, so the numbers are held by behaviour and not merely written down twice.

## One thing the fixtures already show about the run rule

`hey-jarvis-question-sv-soft.wav`, the weakest Swedish Jarvis voice in the fixtures, peaks at **0.4197**,
over its 0.40 threshold, and the loop refuses it under every step, because that peak is one chunk long. The
detector test that pins the peak is about the scorer, not the loop, so nothing said this out loud before.
It is the same shape as the phrase the device pass is meant to catch, and EAGER does not buy it back: at
0.30 the chunks either side are still too low to make a run.
