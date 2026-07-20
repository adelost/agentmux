# Agent Audio Inbox

Small Android-first client for explicit `amux say` events and push-to-talk.
It has no public backend, Firebase, background microphone, LLM, scheduler, or
embedded credential.

The app first tries a short list of Tailscale MagicDNS/private-network
candidates, verifies a versioned Agentmux discovery response, and receives the
default Discord target from that response. Manual server and target values are
kept under **Advanced connection settings** as a recovery path. Hands-free ON
starts `AudioInboxService`; OFF closes the feed and stops playback.

The client consumes:

- `GET /api/audio/events?consumerId=…&target=…` (SSE, bounded replay)
- `POST /api/audio/events/:eventId/receipts`
- `POST /api/tts`
- `GET /api/audio/config` (versioned discovery; no secret material)
- `POST /api/audio/send` (hold-to-record, release-once transcription and delivery)

Push-to-talk records only while the foreground button is held. Releasing it
sends one idempotent turn to the pane bound to the discovered Discord target.
The UI shows the returned transcript, while a stable `Du sa: …` audio event
provides the spoken receipt through the same durable inbox. There is no blind
retry after an ambiguous write.

Receipt order is `received → queued → playback-started → played|failed`.
Playback never begins unless the server has accepted `playback-started`.

Build the debug APK with:

```sh
ANDROID_HOME=/path/to/sdk JAVA_HOME=/path/to/jdk17 ./gradlew testDebugUnitTest assembleDebug
```
