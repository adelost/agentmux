# Link listening cue, row 224

Source scope: `feat/link-listening-cue-224` above Agentmux `4241763`.

## Before

- `WakeEarcons.heard()` was a 150 ms `ToneGenerator.TONE_PROP_BEEP` on `STREAM_MUSIC`.
- It ran only after wake-word detection. TRY, phone push-to-talk and Wear push-to-talk opened their microphones without this receipt.
- p0phone ran Link 1.2.25/code33. Its media stream was 5/15 and system stream 5/7. The exact installed `heard()` was invoked through a reflection probe.
- With media set to 0, AudioFlinger recorded the cue track at `-inf`; after restoring media to 5/15 it was non-muted again. This proves the shipped cue disappears with media mute.
- No Bluetooth device was connected (`mBluetoothHeadsetDevice: null`, SCO inactive, speaker was the active route).
- The p0phone headless QEMU process did not expose audio to WSL's RDPSink, even when launched without `-no-audio`; the captured WAV was digital zero and is rejected as an audibility sample.

## After

- One 130 ms 660→880 Hz rise, 8% amplitude, runs through Android `USAGE_ASSISTANCE_SONIFICATION`, which p0phone maps to `STREAM_SYSTEM`, not media.
- The same shared owner always sends a 28 ms haptic. The phone's declared `LISTENING SOUND` toggle disables only the rise. Wear uses haptic-only feedback and has no meaningless sound row.
- Real starts covered in code: wake accepted, TRY microphone opened, phone recorder started, Wear recorder started. The product has no automatic follow-up question; after a spoken reply it returns to waiting for the wake phrase.

## Proof

- Red before: Link cue/preference tests could not compile, and ProductSpec lacked the fourth field/key/timing.
- ProductSpec: 8/8. Focused cue/audio/graph/preference/Settings JVM tests green. Generated output check, strict changed lint and file-length gate green.
- Signed phone and Wear release APKs assembled. No publication was made.
- p0phone33 native cue test 1/1. `dumpsys vibrator_manager` recorded a finished 28 ms Link haptic while sound was disabled.
- Real phone graph: `LISTENING SOUND` changed ON→OFF, survived force-stop/restart as OFF, then was restored to ON.
- wear34c existing `WearPttGestureTest` 1/1 through the real Activity, graph and recorder. `dumpsys vibrator_manager` recorded Link's 28 ms haptic on both beginCapture attempts. Final image: `/home/adelost/lsrc/.artifacts/link224-2026-09-20/wear-ptt-recording.png`.
- wear34c's original APK was restored byte-identically: SHA-256 `53401c4535055a9234e1ad2305100eca4d5e48ba79873320fd5cc54b2f07db53` before and after. Test package removed, AVD stopped, lock free.
- Phone Settings image: `/home/adelost/lsrc/.artifacts/link224-2026-09-20/settings-phone.png`.
- Exact synthesized product pattern: `/home/adelost/lsrc/.artifacts/link224-2026-09-20/listening-cue-exact-pattern.wav`, SHA-256 `64cea80009e3dece78829d89cc51282d693c619ee700b3aab5e1f9993c53ed3e`. It is generated from `LinkListeningCuePattern`, not a physical speaker recording.

## Remaining physical boundary

No Bluetooth headset was available. Routing to a real connected Bluetooth host is therefore unverified. This does not block the code or local phone/Wear proof, but it remains `BLOCKED kind=HARDWARE` until such a host is handed over.

Public Link release remains behind row 232/184's authenticated TALK TO proof. This row changes no auth and publishes nothing.
