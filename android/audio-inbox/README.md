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

Text and voice turns share the same idempotent conversation model. Recording
exists only while the foreground push-to-talk control is held; release submits
one turn. Link stores a bounded local projection so a restarted Activity can
show recent turns without making that projection the server authority.

**Read replies** is off by default. When enabled, Link requests an MP3 from
`POST /api/tts` and plays it through Media3/ExoPlayer. It is not Android TTS,
does not change the prompt and does not ask the model to generate audio.

**Hands-free** starts `AudioInboxService`, subscribes to the explicit audio
feed and reports receipts in this order:

`received → queued → playback-started → played|failed`

Playback starts only after the server accepts `playback-started`. Turning
hands-free off closes that feed and stops its playback. Explicit `amux say`
remains a separate user-requested channel; Link never opens a background
microphone.

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
- `link-update-android`: the single Link adapter onto CircleKit ReleaseKit;
  Phone and Wear inject only their channel and installed version.
- `app`: Phone hosts, private relay adapter, recording, playback and the
  phone-owned Wear Data Layer session producer.
- `wear`: CircleKit host and a direct `link.v1d.io` mailbox client. Phone sends
  its revocable 30-day session over the Wear Data Layer without exposing
  pairing UI; Wear then discovers live targets, records push-to-talk, polls
  replies and plays them with the watch TTS engine. A per-device session can
  replace that handoff later without changing the mailbox transport.
- CircleKit `designkit`, `ringkit`, `releasekit` and `servicekit`: shared
  Phone/Wear atoms, release workflow and service presentation.

`scripts/check-circlekit-ui.sh` is a focused manual guard: it rejects retired
local renderers and Material3 dependencies beside CircleKit. It is not wired
into Gradle, a git hook or hosted CI.

## Signed updates

Phone and Wear updates come from separate detached Ed25519 manifests under
`link.v1d.io/releases/agentmux-link/{phone|wear}/manifest-v1.json`. CircleKit
owns download, digest/APK identity verification, ready-state recovery and
installer handoff. Link owns one signed manifest parser and two channel data
records; neither host owns a private updater.

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
