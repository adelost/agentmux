# Link: readable conversations

Owner: skyvw:6. Mattias, 2026-09-05. Scope: Link Phone/Wear and shared
CircleKit components + Showcase. Skyvw's concurrent logbook/weather work stays
with its current owners; the shared component fix can be adopted independently.

Acceptance checklist
- [x] Home identifies the actual recipient before text or voice can be sent.
- [x] Choosing a recipient opens all choices; stable IDs drive selection.
- [x] Long names/descriptions remain readable; no text crosses a progress ring.
- [x] Conversation uses readable sentence case and preserves the complete reply.
- [x] Empty, disconnected, recording, waiting, reply, playback and error states
      explain the next action without transport jargon on the home screen.
- [x] Settings retain connection, audio, history, update and host-preview actions.
- [x] Phone, round Watch preview and Wear share selection and capture behavior.
- [x] Shared improvements have working Showcase examples, not app-local copies.
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
Round uses concise Play/Stop rows; the native Wear TTS adapter does not offer
true pause/resume. Phone's anchored player does, through the existing ExoPlayer.

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
- [x] Ordinary Link actions are immediate and produce no full-screen hold flash.
- [x] One active player; A -> B stops A; auto-play and manual play use that owner.
- [x] Phone Pause/resume/stop accessible while scrolling; active reply identified.
- [x] Favorite IDs persist; no hardcoded Kimi/lsrc routing or silent recipient swap.
- [x] Keyboard leaves the composer usable; short landscape temporarily removes
      header/PTT. Keyboard dismissal restores the normal header.
- [x] Every round submenu has visible, reachable Back.
- [x] Info uses the same shared icon geometry/hit target, not a smaller glyph.
- [ ] Final screenshot audit: Phone home/chooser/favorites/settings/info/preview,
      keyboard, playback, recording, errors and round equivalents. Explicit QA
      fixtures prove presentation only; release install/feed proves delivery.

Pre-implementation design assessment: 9/10 for simple navigation and one audio
anchor; the remaining uncertainty is small-round/keyboard space. This is not
a product score: final score requires inspecting the rendered flows.

## Final inspection and runtime proof

Phone portrait, actual landscape and WatchExact ran named Compose actions on
pixel35. The emulator initially ignored orientation requests and letterboxed;
that screenshot was rejected, then actual rotated output was inspected.
The CircleKit test APK's obsolete-target popup also invalidated an early image
set; it was cleaned up and the full Link image set retaken, not called green.

Accepted screenshots: `/tmp/link-ux-proof/files/ux-phone-*`, `ux-wide-*`,
`ux-round-*`: home, recipient chooser, favorites, empty thread, keyboard,
settings, info, preview, loading/playing/waiting/error/offline, recording.
Round lists intentionally scroll at the circular edge; the visible Back has
its own reserved space. Preview fixtures do not prove remote conversations.

Separate real native test: a local HTTP fixture serves decodable WAV through
DirectReplyLoader and AudioInboxService/ExoPlayer. A plays, B replaces A,
Pause and Resume work, C is stopped while HTTP is unfinished and cannot start
after the response arrives. This caught a real buffering-pause race: Pause was
ignored before isPlaying became true. Pause is now unconditional and the UI's
PLAYING receipt comes only from the player's actual isPlaying event.

Focused regression tests also pin stale request epochs, single active state,
recipient identity and generated/native graph totality. No full suite or CI.
The loopback HTTP allowance is debug-only; release network/auth policy stays.

Known existing limit made honest: Phone /tts accepts 1500 characters. Longer
replies remain fully readable and show a reason when requested as audio; no
truncation or fake audio success. Native Wear retains Play/Stop semantics.

Visual assessment: 9/10 for the inspected Phone/WatchExact flows. Key gains are
one explicit destination, readable copy, stable player/composer, consistent info
targets and no accidental nested actions. This is a UX judgement, not a claim
of exhaustive testing or a scored guarantee of live agents/network services.

CircleKit dependency: PR #149, source/tag 7f2f08cbd8295549fced665e602bf4cb08fa64b2,
Maven and Showcase 0.3.57. All six public Maven modules published. No Skyvw
source/settings/runtime changed; adoption remains an independent consumer pin.
Link release target: 1.2.11, Phone code 19 / Wear code 17; existing IDs/signers.
Rollback: prior 1.2.10 (Phone 18 / Wear 16) source is origin/master before this
PR. Installed-device rollback must be rebuilt with a new forward version code;
never overwrite published immutable APK paths or sign with another identity.
