# Clear a conversation on this phone

Mattias 2026-09-14 21:00 (voice, verbatim):

> jag var tydlig också att jag ville att man ska ha något sätt att cleara konversationerna också. som finns manuellt så att man har någon knapp där för att ja, kasta föregående liksom. I alla fall de som är då cachade på mobilen. Sen får de gärna synas då det man skickar även till Discord så att det speglas även där också men det sker ju automatiskt genom det vi har byggt upp redan. Men ja, kontrollera gärna allting är du snäll.

Earlier the same evening he asked for stripped-down UX with little text.

## What it does

- Settings, under LOCAL HISTORY: `CLEAR <recipient>` with the count that will go (`3 on this phone`).
- A held press, the CircleKit destructive rung (900 ms) with the trash icon, the same confirm Skyvw uses for CLEAR ALL of the map cache. Releasing early does nothing.
- Only the selected recipient's turns on this phone go. Nothing is sent to the server, Discord or any agent. The agent pane and the Discord channel keep their own history.
- The row is absent when nothing can be cleared.

## Choices (the agent's, not Mattias's)

- **Selected conversation, not all of them.** The home screen shows one recipient at a time, so clearing what you are looking at is the predictable meaning. Other recipients stay.
- **In-flight turns stay.** A turn that is still sending, waiting for a reply, or being read aloud is kept. Clearing it would drop a reply that is still on its way, and the answer would silently never show. Once it settles, the next clear takes it.
- **Settings, not the home screen.** The home screen already carries recipient, conversation, composer and talk ring; a destructive control there is easy to hit by accident. Settings already owns LOCAL HISTORY.
- **Saved READ ALOUD audio is left to pruning.** It is capped at the ten newest and no longer reachable from a cleared turn.
- **Declared in the product DSL** (`link.history-clear` event, `history.local.clear` → `history.service.clear`), like every other Link command.
