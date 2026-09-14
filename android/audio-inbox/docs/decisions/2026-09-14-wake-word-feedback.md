# Wake word feedback on the talk control (2026-09-14)

## Mattias, 20:27 (voice, verbatim)

> "Eh, vi behöver även göra en mycket tydligare feedback på när eh, ja men typ som Jarvis här med ja, när man har voice activation. Borde vara mycket tydligare. Just nu så syns det inte så jättetydligt. Den liksom, man måste se när den aktiveras tydligare och sen när den lyssnar. Och då vill jag ju liksom se på samma sätt som när man håller inne play-knappen att den spelar in och att den har röst. Och sen så vill jag nästan ha en att man kan se liksom typ att den har nån så här två sekunders eller kanske till och med tre sekunders timeout efter att man har slutat prata innan den faktiskt skickar meddelandet. För att just nu är den alldeles för het på gröten med att skicka iväg meddelandet. Och ja men jag tycker inte UX:en är så bra. Försök och tänk igenom vad bra UX hade varit och sen försök fixa det så gott du kan, är du snäll."

## Mattias, 20:35 (voice, verbatim, relayed by lsrc:0)

> "Okej bra, men gör UX:en så bra som möjligt för röstaktiveringen. Ja. Och sen var det väl om man hade kunnat välja olika wakeups. Eh, ja, Jarvis är väl okej, men hade man haft kanske ändå haft tre att välja mellan men ja, jag behöver inte träna min egen, men är det för komplicerat så duger Jarvis bra. Eh, men ja, försök och göra enkelt, inte för mycket AI-snack, inte för mycket onödigt text, utan försök och göra det rätt avskalat om det går. Eh, så försök gärna och lägga upp det på ett smart sätt eller sådär. Eh, och presentera med visa sen UX:en som du har skapat efteråt så att jag kan granska den, så att du skickar bilder från emulatorn sen när det, ja, hur de olika modesen ser ut när de aktiveras. Så att jag kan godkänna den i så fall. Eh, ja. Försök och göra det på ett smart sätt. Eh, och granska själv dina bilder så att du rättar till fel om du skulle se några fel i bilderna."

Not shipped until he approves the screenshots.

## What was wrong

- Home showed nothing about hands-free. The phase only reached the notification and a Settings row.
- A question was sent after 1.2 s of silence (`EndpointPolicy.trailingSilenceMs`), which cuts people off mid-thought.

## What his words decide

- It must be visible when the wake word activates and while Link listens.
- Listening must look like holding HOLD TO TALK: the recording ring and the live voice level.
- A 2 to 3 s silence timeout before sending, and it must be visible.

## Choices made by the agent (lsrc:0 fork), not by Mattias

- **One control, no new UI.** The home talk ring is the one place he already reads for "recording". Hands-free drives that same `LinkCaptureControl` (CircleKit `RingPressLifecycle` plus `RingAudioCaptureFeedback`), so wake listening and holding look identical.
- **One word per state on the ring** (after 20:35, "inte för mycket onödigt text"). The ring, waveform and digit carry the rest:
  - Armed: `HOLD TO TALK`, with the chosen phrase under it, e.g. `"HEY JARVIS"`.
  - Wake word heard: the ring outline turns teal, the waveform and timer appear, `LISTENING`, one haptic tick with the existing beep.
  - Talking: `LISTENING`, the waveform moves.
  - Paused: `LISTENING` with the seconds left as a digit in the ring. Speaking again removes the digit.
  - Follow-up window: `LISTENING`.
  - Sending: `SENDING`, also while the question is being packed after the countdown reaches zero.
- **Silence timeout 2.5 s.** In the middle of his 2 to 3 s. Two seconds is still close to a natural thinking pause; three seconds makes every short question feel slow. The countdown shows whole seconds, rounded up like any countdown: 3 for the first half second, then 2, then 1.
- **Pressing the ring while hands-free is listening does nothing.** Both paths would fight over the microphone.
- **Not in the product DSL.** The declared wake status stays `phase`, `detail`, `detections`. Level and countdown are a 12.5 Hz capture signal, the same kind of host-fed signal as hold-to-talk's recorded level, which is also not declared. The notification ignores them so it is not rebuilt 12 times a second.
- **Three phrases: Hey Jarvis (default), Hey Marvin, Alexa.** All are the pretrained openWakeWord 0.4.0 models, so nothing is trained. Measured with the same method as the Jarvis switch: edge-tts voices in eight accents, clean and over brown noise, 48 clips per phrase, plus 5.9 min of Swedish speech without any phrase.

  | Phrase | Swedish voices | All voices | False wakes in 5.9 min Swedish | Threshold |
  | --- | --- | --- | --- | --- |
  | Hey Jarvis | 12/12 | 37/48 | 0 | 0.4 (unchanged) |
  | Hey Marvin | 12/12 | 48/48 | 0 | 0.5 |
  | Alexa | 12/12 | 45/48 | 0 | 0.5 |
  | Hey Mycroft | 0/12 | 22/48 | 0 | not offered |

  Kotlin scores match Python on the committed clips: Hey Marvin 0.99994 vs 0.9999, Alexa 0.9990 vs 0.9986, Hey Jarvis 0.9414 vs 0.9414. Alexa will also wake an Amazon Echo in the same room. The pretrained models are CC BY-NC-SA 4.0, which fits private use; Hey Jarvis already shipped under the same terms.
- **Picker: a `WAKE PHRASE` row under WAKE WORD in Settings**, the shared stepped CircleKit choice row. A change applies at once: the microphone loop reopens with the new model. The phrase is declared in the product DSL (`link.wake-phrase`, a `phrase` field and state authority on the wake status); the choice is stored natively beside the other Link preferences.
