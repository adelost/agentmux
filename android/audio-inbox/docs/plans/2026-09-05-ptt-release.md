# One held gesture, one voice message

Scope: Link PTT only. No Skyvw changes, alternate recorder or toggle mode.

- [x] Reproduce current Phone/round behavior with one physical DOWN, wait
  through LISTENING recomposition, then the same pointer UP.
- [ ] Release ends recording and submits exactly once. Cancellation submits
  nothing; leaving the screen never leaves the microphone running.
- [x] Shared copy says HOLD TO TALK before recording and RELEASE TO SEND
  while recording; waveform/time remain visible without shifting the control.
- [x] Use explicitly local fixtures, never send a test recording to a person
  or agent. Distinguish simulated transport from real microphone/gesture proof.
- [ ] Focused tests, named native proof, inspect Phone/round screenshots.
- [ ] Fresh-trunk merge, immutable Phone/Wear release and public byte verification.

Baseline: existing Phone named DOWN → LISTENING → UP smoke passed. No toggle
defect was reproduced. The graph invokes its capture sink synchronously.

The stronger native regression exposed an actual layout defect: inserting the
waveform at BEGIN moved the centered control 70 px under the held finger
(1212.5 → 1282.5 on pixel35). Cancellation/early release already passed.
Fix: retain the shared waveform atom's measured space, not a copied height;
show RELEASE TO SEND during capture and reserve the optional warning line.

Failure-path audit: Phone cleared/released MediaRecorder only after a successful
stop(). An Android stop exception could leave its handle occupied and block the
next recording. Wear already had a tested finally-based RecorderFinalizer.
Move that exact helper/test to link-core and use it from both recorders; clear
the Phone handle before finalization. This is an error-path fix, not evidence
that the ordinary gesture was a toggle. The focused test forces stop failure.

## Proof and limits

- Baseline existing Phone smoke: 1/1; stronger regression red on the 70 px
  movement. After fix: exact BEGIN=1/RELEASE=1/CANCEL=0, one locally captured
  turn, nonempty MediaRecorder payload, no remaining recorder; short touch
  BEGIN=0 and cancelled recording RELEASE=0/delivered=0. Same test runs in
  responsive composition and the real shared Watch surface.
- Native Wear Activity/graph/WearVoiceRecorder: one held gesture ends capture
  on UP; a second recording can begin and CANCEL discards it. Demo catalog
  has no authenticated mailbox, so it correctly reports failed delivery.
  It proves recorder lifecycle, not successful remote upload.
- Public CircleKit 0.3.57 unchanged. No timing change, alternate gesture
  handler, DSL fork, new recorder or Skyvw pin. New tests use named semantics
  to locate the actual control; there is no hardcoded screen coordinate.
- QA application suffix `.pttqa` isolates fixtures from installed user data.
  Temporary Gradle init applies `applicationIdSuffix` to application modules.
  Commands: assembleDebug + assembleDebugAndroidTest, grant RECORD_AUDIO,
  `am instrument -w -e class ...LinkPttGestureTest` (Phone; repeat host=round),
  native Wear `...WearPttGestureTest`, existing Phone `...LinkUxSmokeTest#heldMicrophoneShowsLiveFeedbackAndReleases`.
- Image checklist: entire round control visible; timer/waveform above finger;
  RELEASE TO SEND legible and uncut; visible Wear Back; no arming overlay
  covering active capture. Checked against `/tmp/link-ptt-proof/` Phone,
  WatchExact and native Wear images. First WatchExact screenshot caught the
  previous SurfaceFlinger frame; retaken after a bounded frame-settle, not
  accepted as evidence of active pixels.

Release target 1.2.12 (Phone20, Wear18). Rollback is a forward release from
1.2.11 behavior, never overwriting immutable APK paths or changing signer.
Final merged source/public receipts belong in the PR closure and artifact
receipt after publication, so they cannot self-reference a changing commit.
