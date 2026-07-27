# Agentmux Link UX V2 contract

Contract version: `2.0.0`  
Status: normative  
Android package: `io.agentmux.audioinbox`

## Purpose and ownership

Agentmux Link must let a person keep talking while earlier turns are still in
flight, stop speech immediately, and update the app without browsing for an
APK. The Android app owns presentation, durable local conversation/playback
state, audio focus, MediaSession controls, and release verification. The
transport owns durable acceptance and correlated replies. Views depend only on
`ConversationTransport`; Tailscale and the future public Link adapter implement
that interface without transport-specific state in the UI.

The public `link.v1d.io` mailbox, authentication, and Internet delivery are
owned outside this slice. This slice does not duplicate that backend. The
tailnet voice server remains the current production adapter.

## Independent state machines

There is no global busy flag.

| Machine | States | Terminal or release rule |
| --- | --- | --- |
| Capture | `idle`, `listening`, `finalizing`, `failed` | Finger release finalizes once. Pointer movement and ancestor scrolling do not cancel an owned hold. Backgrounding is an explicit visible cancellation. |
| Upload/send, per turn | `sending`, `sent`/`queued`, `failed` | Durable transport acceptance clears the composer and releases capture/send capacity. An ambiguous write is never retried under a new id. |
| Model wait, per turn | `thinking`, `reply-ready`, `failed` | Each accepted turn has its own correlation id and wait job. Target selection changes never relabel a reply. |
| Incoming reply, per turn | `reply-ready`, `playing`, `paused`, `stopped`, `played`, `failed` | Reply text/transcript/attachments are persisted before optional playback. |
| Playback | `idle`, `preparing`, `playing`, `paused`, `stopped`, `played`, `failed` | Stop is immediate and terminal for automatic delivery. Only an explicit Replay can start a stopped/played item again. |
| Connection | `off`, `connecting`, `connected`, `disconnected`, `configuration-required` | Busy or thinking never means offline. Connection state is transport health only. |
| Update | `idle`, `checking`, `up-to-date`, `available`, `downloading`, `ready-to-install`, `installing`, `failed` | Malformed, stale, untrusted, oversized, hash-mismatched, signer-mismatched, or non-monotonic releases leave the installed version untouched. |

The compact timeline persists at most 100 messages and includes the turn id,
role, actual target, text/transcript, attachment references, created time,
send/wait state, and reply playback state. Favorites remain dynamic, with
preferred ordering `lsrc:3`, `lsrc:10`, `_windows_`. A missing target is shown
as unavailable; a reachable target with outstanding work is shown as
`thinking`, never offline.

## Turn and transport contract

`ConversationTransport` exposes:

- `durableAccept(turnId, target, payload)`: idempotently accepts one text or
  audio turn and returns the visible sent text/transcript plus a reply cursor;
- `awaitReply(turnId, target, cursor)`: returns the correlated reply with the
  actual responding target and attachment references;
- `transportId()` and connection/status projection.

Every UI submission creates one UUID before I/O. Multiple submissions may run
concurrently. The typed composer clears only after durable acceptance. A PTT
capture releases to send exactly once and immediately returns capture capacity
after durable acceptance, even while its reply is still pending.

Tailscale discovery supplies the current adapter. A fake public adapter must
drive the same reducer and render the same timeline without view changes.

## Playback ordering and receipts

Direct phone-turn replies have priority over generic explicit `amux say`
broadcasts. FIFO is preserved within each class. Expired items are terminally
skipped and never played. The durable receipt path is:

`received -> queued -> playback-started -> played|stopped|skipped|failed`

Receiving is not playback. `stopped`, `skipped`, `played`, and `failed` suppress
automatic replay across reconnect and process restart. Explicit Replay is a
local user action and does not fabricate a second delivery receipt. A direct
reply is persisted before it is enqueued, so restart cannot lose transcript or
cause duplicate playback.

The Media3 `MediaSessionService` is the sole audio owner. It requests transient
`MAY_DUCK` focus, plays sequentially, and abandons focus on pause, stop,
completion, failure, disconnect, or Hands-free OFF. Screen, notification,
lock-screen, and headset play/pause/stop actions address the same player.
Global Stop remains visible in the app whenever audio is active.

## PTT interaction

The primary PTT control is circular with a touch target of at least 96 dp.
`ACTION_DOWN` owns the gesture and disallows parent interception until the
matching `ACTION_UP`. Movement has no distance cancellation. `ACTION_CANCEL`
from an actual lifecycle interruption is explicit and visible. Release sends.
There is no hidden app-level maximum duration. Elapsed recording time is
visible and the states read exactly `Listening`, `Sending`, `Waiting for
reply`, or the concrete failure.

## Update security and release contract

The updater adapts Skyvw's verified-download and PackageInstaller pattern:
automatic check, bounded download, SHA-256, installed/archive identity
comparison, signer equality, monotonic version fence, staged installer handoff,
and explicit OS confirmation.

The pinned feed is:

`https://link.v1d.io/releases/agentmux-link/manifest-v1.json`

The document contains `payload` plus base64 `signature`. `payload` has exactly:

```json
{
  "schemaVersion": 1,
  "packageName": "io.agentmux.audioinbox",
  "versionCode": 2,
  "versionName": "1.1.0",
  "apk": {
    "url": "https://link.v1d.io/releases/agentmux-link/agentmux-link-1.1.0.apk",
    "sizeBytes": 1,
    "sha256": "64 lowercase hexadecimal characters"
  },
  "changelog": "bounded plain text",
  "createdAt": "RFC 3339 UTC",
  "expiresAt": "RFC 3339 UTC"
}
```

The signature is Ed25519 over UTF-8 canonical JSON: object keys sorted
lexicographically at every depth, arrays kept in order, JSON string escaping,
and no insignificant whitespace. The public key is pinned in the app.
Manifest and APK URLs must be HTTPS, port 443/default, without credentials,
and on exact host `link.v1d.io`. The manifest is at most 64 KiB, changelog 600
characters, APK 1–150 MiB, validity at most 14 days, and expiry must be in the
future.

Before installer handoff the client verifies:

1. manifest signature and exact package identity;
2. strictly increasing `versionCode` and semantic `versionName`;
3. exact streamed byte count and SHA-256;
4. archive package/version metadata;
5. archive signing certificates equal the installed app certificate set.

Ready metadata is persisted with the hash and reverified before every Install
or Retry. Android `PackageInstaller` may request user confirmation. Existing
SharedPreferences, conversation history, favorites, transport configuration,
and consumer identity are not cleared during upgrade. No unverified APK is
opened or silently installed.

## Acceptance scenarios

1. A 60-second PTT hold survives movement and scroll attempts; release produces
   one durable turn.
2. Turn B is accepted while turn A is thinking; both show independent states
   and replies retain their actual targets.
3. Speech stops mid-sentence immediately and a new turn can be sent while
   another reply waits.
4. Notification/headset controls play, pause, and stop behind the lock screen;
   existing music ducks and recovers.
5. Restart with queued and stopped items preserves transcripts and produces no
   duplicate automatic playback.
6. An older signed build discovers, downloads, verifies, and installs a newer
   signed build with one OS-confirmed tap while app data survives. Invalid
   signature, hash, signer, version, size, or stale metadata fails closed.
7. Tailscale and fake public adapters produce the same reducer/timeline output.

## Manual acceptance receipt

The release receipt must record:

- physical device model, Android version, installed old/new version code and
  version name, package and certificate SHA-256;
- PTT duration and one accepted turn id;
- overlapping turn ids, targets, and reply labels;
- stopped item id/state and stop latency observation;
- locked-screen notification/headset actions plus music duck/recovery;
- restart/reconnect item ids and before/after playback counts;
- update manifest URL/hash/signature result, APK URL/bytes/SHA-256, installer
  confirmation, post-upgrade data checks;
- Tailscale/fake-public reducer test result;
- git head, APK path/hash, focused test commands/counts/runtimes, and any honest
  limitation.
