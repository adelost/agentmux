# Link: recent conversations on the watch

Bounded follow-up to the conversation review; no new history service or layout
engine. Phone and Wear consume the same recipient-scoped, retained 50-turn
window. Wear currently holds that window in its controller, not a disk archive;
this slice must not promise server history or persistence that does not exist.

Design: retain the calm watch home and unchanged voice gesture. HISTORY opens
recent messages, newest first. A row identifies the user's message and local
time; selecting its stable turn ID opens the complete exchange. New replies
must not change the exchange being read. Back returns to the same list. The
existing shared prose/action atoms provide text and audio on both hosts.
Wear offers Play/Stop, never fake pause/resume. Only the existing player owns
audio. Phone retains its real anchored pause/resume and attachment actions.

Acceptance
- [ ] Older messages are reachable, including messages without replies.
- [ ] Selected recipient ID filters history exactly; another window's turns
      are never selected by a label or array position.
- [ ] Full user text and reply remain readable with scroll/crown and visible Back.
- [ ] Empty history, long content and eviction of an open turn are honest.
- [ ] Existing single-player command routing is used for any selected turn.
- [ ] Hold-to-record/release-to-send and stationary press target are unchanged.
- [ ] Shared small presentation tests + compile; bounded named Phone/Wear proof
      with local fixtures only, no sends to a real person/agent.
- [ ] Fresh-master merge, exact signed publication/verification, final receipts
      and actual inspected screenshots; no bridge/host install or restart.

No CircleKit source edits. Any dependency adoption must be an already public
version agreed at the short resource handover, not a parallel icon/palette fork.
