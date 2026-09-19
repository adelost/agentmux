# Agentmux Link

Android client for direct Agentmux conversations, push-to-talk and explicit
audio playback. The Phone UI is a CircleKit consumer; shared conversation
state and policies live in the Android-free `link-core` module.

## Connection routes

Link chooses a route from the target catalog rather than assuming two fixed
agents:

- **Private Link** discovers a versioned Agentmux audio endpoint on the local
  or Tailscale network. A schema-2 discovery response supplies the available
  target ids, labels, panes and audio targets.
- **Public Link** is the optional `https://link.v1d.io` mailbox. Android uses a
  PKCE login, receives the user's target catalog and exchanges text or bounded
  voice messages without exposing a private Agentmux endpoint.
- **Windows rescue** is a private target returned by the Windows manager when
  that service is available.

There is no manual “Advanced connection settings” screen. Connection status,
Public Link connect/disconnect, hands-free playback, reply reading, bounded
local history and signed updates are under Link settings.

## Conversation and audio behavior

Text and voice turns share the same idempotent conversation model. Push-to-talk
records while its foreground control is held; release submits one turn.
The optional wake word starts a separate hands-free question as described below.
Link stores a bounded local projection so a restarted Activity can
show recent turns without making that projection the server authority.

**Read replies** is off by default. When enabled, Link requests an MP3 from
`POST /api/tts` and plays it through Media3/ExoPlayer. It is not Android TTS,
does not change the prompt and does not ask the model to generate audio.

**Announcements** starts `AudioInboxService`, subscribes to the explicit audio
feed and reports receipts in this order:

`received → queued → playback-started → played|failed`

Playback starts only after the server accepts `playback-started`. Turning
announcements off closes that feed and stops its playback. Explicit `amux say`
remains a separate user-requested channel.

**Wake word** is off by default and phone-only. When turned on, the foreground
`WakeWordService` owns one microphone, shows an ongoing notification with Stop,
and runs wake phrase detection on device (Hey Jarvis, Hey Marvin or Alexa, picked
in Settings). After the phrase it records the question
until 2.5 s of silence (Silero VAD, 30 s cap), encodes the same AAC/MPEG-4 file
as push-to-talk and submits it through the shared conversation owner to the
selected target. It plays short tones while waiting, reads the reply aloud with
`POST /api/tts` and then waits for the next wake phrase. Speech without that phrase
does not start another question. The phrase can interrupt reply playback and start
the next question. Tapping the talk ring while it says LISTENING cancels that
question; its audio is discarded, including an encoding result that arrives late.
Every stop reason is shown in the
notification and the Settings status row. On the home screen the talk ring shows
it like holding HOLD TO TALK: listening, live voice level and the countdown
before a paused question is sent. Turning it on asks for Unrestricted
battery use so the phone does not stop the listening service; Stop in the
notification turns the preference off. Without the toggle Link never opens a
background microphone.

Recording starts on press; release sends once, and a press shorter than 500 ms
is discarded. Sliding outside the control cancels. Text Send is disabled for
empty or whitespace-only drafts. These rules are shared across the native hosts.

History keeps at most 50 exchanges globally, filtered by the exact recipient ID.
Phone persists them; Wear currently keeps them for the process lifetime only.
This is not a Discord archive. Each message/reply is capped at 12,000 UTF-16
characters with a visible shortening marker, and total retained text at 256,000
characters. Older exchanges are evicted first; the composer accepts 4,000.

Phone keeps the ten newest generated replies in app storage across restarts:
exact server+text identity, at most 10 files/32 MiB, oldest pruned first. A
reply with saved audio shows its length, a pruned one shows AUDIO EXPIRED (tap
to regenerate when its route has speech), and only a real failure asks to retry
with its reason. Long replies are read as their SUMMARY line or first paragraph. Playback uses a separate copy, so finishing a
reply does not delete the reusable cache entry. First-time speech still needs
the server; this is not offline generation. Wear retains its native TTS engine.

Private transport currently uses:

- `GET /api/audio/config`
- `POST /api/audio/send`
- `GET /api/events/:agent/:pane?prompt=…`
- `GET /api/audio/events?consumerId=…&target=…`
- `POST /api/audio/events/:eventId/receipts`
- `POST /api/tts`

Public Link uses the `/auth/*` and `/api/link/*` routes on `link.v1d.io`.

## Modules and UI ownership

- `link-core`: Android-free reducer, history, recovery, connection and voice
  upload policies.
- `link-transport`: Android-free public mailbox client and conversation port
  shared byte-for-byte by Phone and Wear.
- `link-session-android`: the single Android Keystore-backed session store.
- `wakeword`: app-agnostic, Android-free wake word engine (openWakeWord
  detector, Silero VAD endpoint, the microphone listening loop, phase reducer)
  and its ONNX models. The
  product declares it with `product-spec/src/wake-word.ts`, a reusable
  `defineWakeWordFeature(prefix)` building block.
- `link-update-android`: the single Link adapter onto CircleKit ReleaseKit;
  Phone and Wear inject only their channel and installed version.
- `app`: Phone hosts, private relay adapter, recording, playback and the
  phone-owned Wear Data Layer session producer.
- `wear`: CircleKit host and a direct `link.v1d.io` mailbox client. Phone sends
  its revocable 30-day session over the Wear Data Layer without exposing
  pairing UI; Wear then discovers live targets, records push-to-talk, polls
  replies and plays them with the watch TTS engine. A per-device session can
  replace that handoff later without changing the mailbox transport.
- CircleKit `designkit`, `ringkit`, `releasekit`, `releasekit-ui` and
  `servicekit`: shared Phone/Wear atoms, release workflow, canonical update
  rows and service presentation.

`scripts/check-circlekit-ui.sh` is a focused manual guard: it rejects retired
local renderers and Material3 dependencies beside CircleKit. It is not wired
into Gradle, a git hook or hosted CI.

## Signed updates

Phone and Wear updates come from separate detached Ed25519 manifests under
`link.v1d.io/releases/agentmux-link/{phone|wear}/manifest-v1.json`. CircleKit
owns download, digest/APK identity verification, ready-state recovery and
installer handoff. Link owns one signed manifest parser and two channel data
records; neither host owns a private updater.

The signed manifest's `createdAt` is emitted by the release publisher
immediately before immutable-first publication. Link preserves that absolute
UTC epoch through ReleaseKit; `releasekit-ui` localizes it at the device UI
boundary and omits `PUBLISHED` when a source provides no publication time.

Release signing inputs are local operator configuration, never repository
paths:

| Gradle property | Environment variable |
| --- | --- |
| `agentmuxLinkReleaseStore` | `AGENTMUX_LINK_RELEASE_STORE` |
| `agentmuxLinkReleaseStorePassword` | `AGENTMUX_LINK_RELEASE_STORE_PASSWORD` |
| `agentmuxLinkReleaseKeyPassword` | `AGENTMUX_LINK_RELEASE_KEY_PASSWORD` |
| `agentmuxLinkReleaseKeyAlias` | `AGENTMUX_LINK_RELEASE_KEY_ALIAS` |

The alias defaults to `agentmux-link`; the store and passwords have no
repository default.

## Local development

Use JDK 17 and an Android SDK. Build only the surface being changed:

```sh
cd android/audio-inbox
./gradlew :app:assembleDebug
./gradlew :wear:assembleDebug
```

Run focused tests with `--tests`, for example:

```sh
./gradlew :app:testDebugUnitTest \
  --tests 'io.agentmux.audioinbox.LinkReleaseTest'
```

Do not add hosted CI or wire manual check scripts into the build/release path.
