# Wake word feedback on the talk control (2026-09-14)

## Mattias, 20:27 (voice, verbatim)

> "Eh, vi behöver även göra en mycket tydligare feedback på när eh, ja men typ som Jarvis här med ja, när man har voice activation. Borde vara mycket tydligare. Just nu så syns det inte så jättetydligt. Den liksom, man måste se när den aktiveras tydligare och sen när den lyssnar. Och då vill jag ju liksom se på samma sätt som när man håller inne play-knappen att den spelar in och att den har röst. Och sen så vill jag nästan ha en att man kan se liksom typ att den har nån så här två sekunders eller kanske till och med tre sekunders timeout efter att man har slutat prata innan den faktiskt skickar meddelandet. För att just nu är den alldeles för het på gröten med att skicka iväg meddelandet. Och ja men jag tycker inte UX:en är så bra. Försök och tänk igenom vad bra UX hade varit och sen försök fixa det så gott du kan, är du snäll."

## What was wrong

- Home showed nothing about hands-free. The phase only reached the notification and a Settings row.
- A question was sent after 1.2 s of silence (`EndpointPolicy.trailingSilenceMs`), which cuts people off mid-thought.

## What his words decide

- It must be visible when the wake word activates and while Link listens.
- Listening must look like holding HOLD TO TALK: the recording ring and the live voice level.
- A 2 to 3 s silence timeout before sending, and it must be visible.

## Choices made by the agent (lsrc:0 fork), not by Mattias

- **One control, no new UI.** The home talk ring is the one place he already reads for "recording". Hands-free drives that same `LinkCaptureControl` (CircleKit `RingPressLifecycle` plus `RingAudioCaptureFeedback`), so wake listening and holding look identical.
- **States on the ring:**
  - Armed: `HOLD TO TALK`, sub `OR SAY "HEY JARVIS"`.
  - Activated: the ring turns active, the waveform appears with live level, `LISTENING`, `SPEAK NOW`, one haptic tick with the existing beep.
  - Talking: `LISTENING`, `PAUSE TO SEND`.
  - Paused: `SENDING IN 2 S`, with the seconds left in the ring centre. Speaking again resets it.
  - Follow-up window: `LISTENING`, `ASK A FOLLOW-UP`.
  - Sending: `SENDING`.
- **Silence timeout 2.5 s.** In the middle of his 2 to 3 s. Two seconds is still close to a natural thinking pause; three seconds makes every short question feel slow. The countdown shows whole seconds, rounded up like any countdown: 3 for the first half second, then 2, then 1.
- **Pressing the ring while hands-free is listening does nothing.** Both paths would fight over the microphone.
- **Not in the product DSL.** The declared wake status stays `phase`, `detail`, `detections`. Level and countdown are a 12.5 Hz capture signal, the same kind of host-fed signal as hold-to-talk's recorded level, which is also not declared. The notification ignores them so it is not rebuilt 12 times a second.
