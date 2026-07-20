# Agent Audio Inbox

Small Android-first client for explicit `amux say` events. It has no public
backend, Firebase, microphone, LLM, scheduler, or embedded credential.

The one screen stores a Tailscale-reachable voice-server URL and the Discord
channel id used as the event target. Hands-free ON starts
`AudioInboxService`; OFF closes the feed and stops playback.

The client consumes:

- `GET /api/audio/events?consumerId=…&target=…` (SSE, bounded replay)
- `POST /api/audio/events/:eventId/receipts`
- `POST /api/tts`

Receipt order is `received → queued → playback-started → played|failed`.
Playback never begins unless the server has accepted `playback-started`.

Build the debug APK with:

```sh
ANDROID_HOME=/path/to/sdk JAVA_HOME=/path/to/jdk17 ./gradlew testDebugUnitTest assembleDebug
```
