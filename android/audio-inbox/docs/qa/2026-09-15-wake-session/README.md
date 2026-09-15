# Link wake session, cancellation and connection receipts

Source: `7a51a20`, completing the preserved `3848893`/`93c7f87` work. Candidate
Link 1.2.20, Phone 28 and Wear 26. The documentation commit adds no product code.

[Reproducible synthetic proof archive](https://github.com/adelost/agentmux/releases/download/agentmux-link-v1.2.20/link-wake-proof-7a51a20.tar.gz)

## Behavior

- A completed reply returns to waiting for the wake phrase. Ordinary subsequent
  speech does not start another question.
- Tapping LISTENING/TAP TO CANCEL drops the question. A delayed encoding result
  must still belong to the current detection before it can be submitted.
- The wake phrase during playback stops that playback and captures a new question.
- Announcement-feed off/playing/brief reconnection is distinct from a route outage.

## Checks actually run

- 28 focused JVM tests: WakeSession 12, WakeListeningLoop 3, LinkWakeTurns 3,
  LinkConnectionReceipt 3, FeedConnectionReceipts 3, LinkHandsFreeTalk 4.
- New delayed-completion regression: red before the capture identity guard;
  green after. A cancelled first question cannot replace a second capture.
- Product declaration: seven tests and `check-generated` passed.
- App lint: 15 errors before, zero after, 23 warnings remain. Compatibility
  fixes use ServiceCompat, explicit MediaMetadataRetriever release, the correct
  Media3 result symbols/opt-in, and an API-qualified navigation-bar resource.
- Five native pointer/MediaRecorder/product-graph tests passed in 9.388 s,
  including a real tap on the hands-free ring and no PTT begin/send.
- Final source: Phone and Wear release builds passed; focused tests and lint
  passed on the rebased source. Signed APK certificates match the published 1.2.19.

## Real app flow, synthetic boundary

`LinkWakeFlowNativeTest` runs the real Activity, ONNX wake detector, Silero VAD,
WakeWordService, AAC encoder, conversation HTTP client and Media3 playback.
The boundary is a localhost server with fixed transcripts and decodable silent
reply audio. No real agent, Discord, ASR or paid TTS receives a test request.
Input speech is pre-generated synthetic PCM. The build uses the isolated debug
package `io.agentmux.audioinbox.takeoverqa`; existing installations are untouched.

| Scenario | Result |
|---|---|
| Cancel during actual heard speech | Returns to HOLD TO TALK; zero submitted questions after remaining PCM/silence |
| Completed reply then 28 s ordinary speech | Exactly one question, no new detection, waits for the phrase, no DISCONNECTED |
| Wake phrase during reply | Playback stops; a new capture is visible; exactly two questions after the second reply |

The three final scenarios passed individually through instrumentation. The
archive contains each log and the mock request count. `run-flow.py` runs them
under the ordinary serial QA lock via `with-phone.sh`; child processes do not
inherit its descriptor. It removes its reverse port and battery exemption,
stops the isolated app and closes its localhost server.

## Visual evidence

Accepted and inspected: `cancel-before.png` and `flow-cancel.png` show the
actual listening ring and return to HOLD TO TALK with empty history. The
ordinary Activity was also exercised without Compose's test clock:
`ordinary-26s.png`/`ordinary-54s.png` show the full reply, all labels/icons and
the idle wake phrase; the mock still records exactly one question at 54 s.

Two instrumentation captures after playback have incomplete static text despite
passing behavioral assertions. They are not accepted as visual proof. The
ordinary-Activity captures above cover the same displayed state; no product
renderer was changed to work around a test screenshot.

The previous owner's failed S3 did not prove the cancel button was broken:
`[516,2135][566,2185]` was stripped to three tokens and produced a tap at
`(1350,1067783)`, outside the screen. New pointer tests address the control by
its semantics. Two setup attempts in this pass were rejected before behavioral
proof: an unquoted remote-shell WAV separator, and a text selector for a row
whose contract is a content description. The emulator also initially had its
network radios off; the existing guest-network helper restored its network.

## Reproduce

Use JDK 17, the repository's Gradle wrapper and `--tests` for the six classes
listed above. The archive includes `qa-package.gradle`, `run-native.sh`,
`run-flow.py`, `run-visual.py`, `mock.mjs`, synthetic WAV inputs and source/APK
hashes. The original runner paths refer to the preserved implementation
worktree; point ROOT at a checkout of the recorded source when rerunning.

Limits: emulator API 35, no physical microphone/headset/acoustic echo test and
no runtime check on API 26–28. Those API constraints were checked by lint.
Wake word remains Phone-only; Wear receives shared declarations and a matching
release build, not a new hands-free capability.
