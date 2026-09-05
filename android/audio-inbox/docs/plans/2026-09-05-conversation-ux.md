# Link: readable conversations

Owner: skyvw:6. Mattias, 2026-09-05. Scope: Link Phone/Wear and shared
CircleKit components + Showcase. Skyvw's concurrent logbook/weather work stays
with its current owners; the shared component fix can be adopted independently.

Acceptance checklist
- [ ] Home identifies the actual recipient before text or voice can be sent.
- [ ] Choosing a recipient opens all choices; stable IDs drive selection.
- [ ] Long names/descriptions remain readable; no text crosses a progress ring.
- [ ] Conversation uses readable sentence case and preserves the complete reply.
- [ ] Empty, disconnected, recording, waiting, reply, playback and error states
      explain the next action without transport jargon on the home screen.
- [ ] Settings retain connection, audio, history, update and host-preview actions.
- [ ] Phone, round Watch preview and Wear share selection and capture behavior.
- [ ] Shared improvements have working Showcase examples, not app-local copies.
- [ ] Inspect screenshots of every route + meaningful state on Phone and Wear;
      iterate before assigning a visual quality score of at least 9/10.
- [ ] Focused tests, fresh-main merge, publish signed Link update and verify
      public manifest/signature/APK; publish CircleKit/Showcase with provenance.

Design: OLED black, warm-white actions, color only for meaningful state. A
conversation header answers “who”; a list answers “who else”. Technical route
details stay in settings. Readable rows may grow; labels never shrink to fit
arbitrary prose. The shared action receipt reserves separate measured space for
ring and copy. Phone and Wear differ in layout and text-entry affordance only.
