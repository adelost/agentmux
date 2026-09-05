# One held gesture, one voice message

Scope: Link PTT only. No Skyvw changes, alternate recorder or toggle mode.

- [ ] Reproduce current Phone/round behavior with one physical DOWN, wait
  through LISTENING recomposition, then the same pointer UP.
- [ ] Release ends recording and submits exactly once. Cancellation submits
  nothing; leaving the screen never leaves the microphone running.
- [ ] Shared copy says HOLD TO TALK before recording and RELEASE TO SEND
  while recording; waveform/time remain visible without shifting the control.
- [ ] Use explicitly local fixtures, never send a test recording to a person
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
