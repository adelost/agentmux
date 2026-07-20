# Agent Audio Inbox

Small Android-first client for explicit `amux say` events. It has no public
backend, Firebase, microphone, LLM, scheduler, or embedded credential.

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

Receipt order is `received → queued → playback-started → played|failed`.
Playback never begins unless the server has accepted `playback-started`.

Build the debug APK with:

```sh
ANDROID_HOME=/path/to/sdk JAVA_HOME=/path/to/jdk17 ./gradlew testDebugUnitTest assembleDebug
```
