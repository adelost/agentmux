# Agentmux Link

Small Android-first conversation and explicit-audio client. It has no public
backend, Firebase, background microphone, embedded LLM, scheduler, or embedded
credential.

Two favorites are discovered independently over Tailscale:

- **L-source 3** through the normal WSL Agentmux bridge.
- **Windows rescue** through the Windows-native manager, which remains usable
  when WSL, tmux, and the WSL bridge are offline.

The app supports ordinary text chat and hold-to-talk. Recording exists only
while the foreground button is held; release sends exactly one idempotent turn.
The normal agent answer is shown in the local conversation. **Read replies
aloud** is an optional, off-by-default local Android TTS setting. It does not
alter the prompt and never requires the agent to generate audio.

Explicit `amux say` remains a separate on-demand channel. Turning hands-free
listening on starts `AudioInboxService`; turning it off closes that feed and
stops playback. Thus an agent speaks through `amux say` only when the user asks
for it, regardless of the local reply-reading preference.

The app tries a short list of Tailscale MagicDNS/private-network candidates and
accepts only versioned discovery responses. Manual WSL server and Discord target
values stay under **Advanced connection settings** as a recovery path.

The client consumes:

- `GET /api/audio/events?consumerId=…&target=…` (SSE, bounded replay)
- `POST /api/audio/events/:eventId/receipts`
- `POST /api/tts`
- `GET /api/audio/config` (versioned discovery; no secret material)
- `POST /api/audio/send` (text or release-once audio)
- `GET /api/events/:agent/:pane?prompt=…` (exact-turn WSL reply)

The Windows-native service implements the same config/send routes on its own
Tailscale address and returns the manager answer directly. No ambiguous write is
retried. A unique, non-voice correlation marker prevents two identical prompts
from returning the wrong historical pane response.

Receipt order is `received → queued → playback-started → played|failed`.
Playback never begins unless the server has accepted `playback-started`.

Build the debug APK with:

```sh
ANDROID_HOME=/path/to/sdk JAVA_HOME=/path/to/jdk17 ./gradlew testDebugUnitTest assembleDebug
```
