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

## Revised interaction design — Mattias's follow-up

No release until the audio, timing and copy checks below pass. A conversation
is not a flight instrument: do not change the altimeter's deliberate actions.
Link declares immediate navigation/media actions; recording alone is a hold.

Phone sketch (black canvas, existing CircleKit atoms):

    LINK                                      settings
    [recipient icon]  lsrc:3                    change
    --------------------------------------------------
    YOU                           conversation scrolls
    Hej!
    lsrc:3
    Hej Mattias. Vad vill du kika på?            play
    --------------------------------------------------
    pause     lsrc:3 · playing       0:12 / 0:48   stop
    [Message                                  ] send
                        hold microphone

Round: same recipient/action semantics; scrollable home, full reply screen,
voice screen, settings. Every secondary screen has a reachable visible Back.
The player is a dedicated compact media view on round, not tiny inline text.

Recipient chooser: current selection + favorites first, then all connected
windows. No fixed model/agent presets. A separate Edit favorites mode uses the
same named rows to tick stable window IDs; favorites never silently change the
send destination and never resurrect an unavailable delivery route.

Audio: one current media owner. Choosing a different reply replaces the old
one. Pause/resume/stop are immediate and remain reachable when the conversation
scrolls. Keep the existing auto-read preference, clearly named AUTO-PLAY REPLIES.
Use actual playback position/status; never pretend decorative bars are a
measured waveform. The recording waveform continues to use recorded levels.

Copy: recipient ID, YOU, Message, Settings, Play, Pause, Stop, Favorites.
Remove repetitive route/status prose from home. Transport detail belongs in
Settings; longer explanations are optional Info, using the shared icon control.
No all-caps paragraphs, clipped replies, role labels pretending to be addresses,
or claims such as sent/playing before the corresponding runtime state.

Additional binary acceptance:
- [ ] Ordinary Link actions are immediate and produce no full-screen hold flash.
- [ ] One active player; A -> B stops A; auto-play and manual play use that owner.
- [ ] Pause/resume/stop accessible while scrolling; active reply is identified.
- [ ] Favorite IDs persist; no hardcoded Kimi/lsrc routing or silent recipient swap.
- [ ] Keyboard leaves header/composer usable, including landscape.
- [ ] Every round submenu has visible, reachable Back.
- [ ] Info uses the same shared icon geometry/hit target, not a smaller glyph.
- [ ] Final screenshot audit: Phone home/chooser/favorites/settings/info/preview,
      keyboard, playback, recording, errors and round equivalents. Explicit QA
      fixtures prove presentation only; release install/feed proves delivery.

Pre-implementation design assessment: 9/10 for simple navigation and one audio
anchor; the remaining uncertainty is small-round/keyboard space. This is not
a product score: final score requires inspecting the rendered flows.
