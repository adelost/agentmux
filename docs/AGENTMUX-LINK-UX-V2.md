# Agentmux Link UX V2 contract

Contract version: `2.2.1`

Status: normative

Android package: `io.agentmux.audioinbox`

## Purpose and ownership

Agentmux Link must let a person keep talking while earlier turns are still in
flight, stop speech immediately, and update the app without browsing for an
APK. The Android app owns presentation, durable local conversation/playback
state, audio focus, MediaSession controls, and release verification. The
transport owns durable acceptance and correlated replies. Views depend only on
`ConversationTransport`; Tailscale and the public Link adapter implement
that interface without transport-specific state in the UI.

The public `link.v1d.io` mailbox, authentication, and Internet delivery are
owned outside this slice. This slice does not duplicate that backend. The
Android adapter consumes its authenticated send/await-reply contract while the
tailnet voice server remains an independent fallback adapter.

Public Link PKCE state is restart-safe: the verifier is encrypted under the
Android Keystore key before opening the Custom Tab, is never placed in an
Intent, log, or argument, and a new login replaces the prior pending value.
The callback reloads that exact verifier after process recreation. A failed
exchange preserves it for retry; successful encrypted session persistence and
pending-verifier removal are one expected-verifier transition. No login state
is projected when that durable commit fails.

## Module and migration architecture

Agentmux Link adopts Kotlin/Compose only at the presentation seam. Existing
Java transport, persistence, recording, TTS, and `MediaSessionService` code
continues to run throughout the migration.

```text
                  ┌────────────────────────────┐
                  │ :link-core (pure Kotlin)   │
                  │ reducers, immutable state, │
                  │ commands, target selection,│
                  │ update presentation        │
                  └──────────────┬─────────────┘
                         state + │ commands
             ┌───────────────────┴───────────────────┐
             │                                       │
┌────────────▼─────────────┐            ┌────────────▼─────────────┐
│ :app (phone)             │            │ :wear (milestone 2)      │
│ Kotlin/Compose screen    │            │ Kotlin/Wear Compose      │
│ app-local design atoms   │            │ tiny round screen        │
└────────────┬─────────────┘            └────────────┬─────────────┘
             │ Java-compatible ports                │ public/fake port
┌────────────▼──────────────────────────────────────▼─────────────┐
│ Existing app-local Java domain/service                         │
│ ConversationTransport adapters · stores · recorder · TTS ·     │
│ AudioInboxService/MediaSession · updater installer/verifier    │
└────────────────────────────────────────────────────────────────┘
```

`:link-core` has no Android, View, Compose, HTTP, filesystem, or transport
dependency. Phone and Wear reducer tests use the same fixtures and expected
turn/playback/target/update transitions. `:wear` is not on the phone V2 critical
path; it is added only after the phone reducer and urgent stop/concurrency/update
flow are stable.

The following is shared as source code:

- immutable conversation turn, capture, connection, playback and update
  presentation models;
- pure reducer and command vocabulary;
- target selection/favorite ordering;
- app-local color, spacing, typography, circular-control, and touch-size tokens
  that were adapted from Skyvw's `designkit`;
- generic signed-manifest parsing and updater security policy where Android-free.

The following is shared only as a traced visual/security contract:

- Skyvw's Graphite palette hierarchy, restrained surfaces, readable contrast,
  compact spacing, circular primary-action language, and round-safe insets;
- Skyvw `releasekit` state names, bounded verified download, archive identity,
  signer, and `PackageInstaller` fences.

Skyvw altimeter dials, altitude semantics, map components, and app-specific
widgets are not copied. Agentmux Link owns its PTT disc, reply/audio card,
timeline, and target chooser. There is no sibling-path Gradle dependency,
submodule, authenticated build-time fetch, or private binary dependency. The
generic kit is ported with provenance because the existing modules cannot be
consumed hermetically outside the Skyvw build today. Extraction into a
versioned v1d Android kit is considered only after phone and Wear prove the
boundary as two consumers.

### Navigation sketches

Phone is one vertically scrolling Compose destination:

```text
┌ Agentmux Link                 ● Connected ┐
│ [lsrc:3] [lsrc:10] [_windows_]            │
│ ┌ compact timeline / status / media ────┐ │
│ │ You → lsrc:3        thinking          │ │
│ │ lsrc:10             reply ready       │ │
│ │ [Play] [Pause] [Stop] [Replay]        │ │
│ └───────────────────────────────────────┘ │
│ [ Type another message…          ][Send]  │
│               ◯ HOLD TO TALK              │
│ [■ STOP AUDIO] when anything is active    │
│ Connection · Hands-free · Update v…       │
└───────────────────────────────────────────┘
```

The future round-watch screen deliberately omits the full timeline:

```text
          ╭──────────────╮
       ╭──┤ ● Connected  ├──╮
      │   │   lsrc:3 ▾   │   │
      │   │              │   │
      │   │   ◯ HOLD     │   │
      │   │              │   │
      │   │ latest reply │   │
       ╰──┤ Play Stop ↻  ├──╯
          ╰──────────────╯
```

### Incremental migration and rollback

1. Add and test `:link-core`; existing Java Views remain the production UI.
2. Introduce Java-compatible transport/service/store ports and feed their
   snapshots into the reducer. No behavioral route is removed.
3. Build the phone Compose screen beside the existing Java panel and switch
   `MainActivity` to the Compose host only after reducer/component tests pass.
4. Keep `AudioInboxService`, MediaSession, recorder, HTTP clients, and persisted
   preference keys intact. The Compose screen issues commands to these ports.
5. Land the signed updater and physical old-to-new phone rehearsal.
6. After phone stability, add `:wear` using the same reducer/tokens and a fake
   public adapter; enable live public transport only when its external contract
   is available.

The explicit no-big-bang rollback point is the commit immediately before step
3's activity switch. Reverting only that switch restores the Java UI while
retaining the tested reducer, service fixes, and unchanged on-device data. No
storage migration is destructive, so downgrade to the prior UI remains
possible during the migration window.

## Independent state machines

There is no global busy flag.

| Machine | States | Terminal or release rule |
| --- | --- | --- |
| Capture | `idle`, `listening`, `finalizing`, `failed` | Finger release finalizes once. Pointer movement and ancestor scrolling do not cancel an owned hold. Backgrounding is an explicit visible cancellation. |
| Upload/send, per turn | `sending`, `sent`/`queued`, `failed` | Durable transport acceptance clears the composer and releases capture/send capacity. An ambiguous write is never retried under a new id. |
| Model wait, per turn | `thinking`, `reply-ready`, `failed` | Each accepted turn has its own correlation id and wait job. Target selection changes never relabel a reply. |
| Reply wait, per turn | `none`, `thinking`, `reply-ready`, `failed` | Reply text/transcript/attachments and their actual responding target are persisted before optional playback. |
| Playback, per turn | `idle`, `queued`, `playing`, `paused`, `stopped`, `played`, `skipped`, `failed` | Stop/skip are terminal for automatic delivery and do not erase reply-ready truth. Only an explicit Replay can start a terminal item again. |
| Connection | `off`, `connecting`, `connected`, `disconnected`, `configuration-required` | Busy or thinking never means offline. Connection state is transport health only. |
| Update | `idle`, `checking`, `up-to-date`, `available`, `downloading`, `ready-to-install`, `installing`, `failed` | Malformed, stale, untrusted, oversized, hash-mismatched, signer-mismatched, or non-monotonic releases leave the installed version untouched. |

The compact timeline persists at most 100 messages and includes the turn id,
role, actual target, text/transcript, attachment references, created time, and
three independent per-turn axes: `deliveryPhase`, `replyPhase`, and
`playbackPhase`, each with its own bounded error detail. Playback never
overwrites delivery or reply truth. Favorites remain dynamic, with
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

Tailscale discovery and authenticated Public Link discovery supply independent
adapters. Public and tailnet adapters drive the same reducer and render the same
timeline without view changes; target busy/thinking state never changes either
transport's online projection.

## Playback ordering and receipts

Direct phone-turn replies have priority over generic explicit `amux say`
broadcasts. FIFO is preserved within each class for replies arriving live.
Reconnect does not reverse that live ordering: all recovered replies stay in
timeline order, historical audio is marked honestly as available/skipped, and
at most the newest eligible, non-expired direct reply may autoplay. Generic
audio remains lower priority. Expired items are terminally skipped and never
played. The durable receipt path is:

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

Public Link applies one byte fence, not a duration fence: recording continues
until release, warns visibly from 80% of the 5 MiB upload limit, and a larger
released file fails visibly without truncation or durable acceptance. The
former public-contract phrase “≤60 s” is superseded by this rule.

## Update security and release contract

The updater adapts Skyvw's verified-download and PackageInstaller pattern:
automatic check, bounded download, SHA-256, installed/archive identity
comparison, signer equality, monotonic version fence, staged installer handoff,
and explicit OS confirmation.

Phone and Wear use separate pinned catalogs and APK identities:

- phone: package `io.agentmux.audioinbox`, catalog
  `https://link.v1d.io/releases/agentmux-link/phone/manifest-v1.json`;
- Wear milestone 2: package `io.agentmux.audioinbox.wear`, catalog
  `https://link.v1d.io/releases/agentmux-link/wear/manifest-v1.json`.

Each product has an independent monotonic `versionCode`, semantic
`versionName`, pinned application id, pinned release manifest key, and pinned
APK signing certificate. A phone artifact can never satisfy the Wear catalog
or vice versa. Key rotation requires an app release that pins both old and new
manifest keys before a later catalog switches signing keys; APK certificate
rotation follows Android signing lineage and is never inferred from the
manifest.

The manifest document is the payload below. Its adjacent `.sig` response
contains the detached base64 signature. The payload has exactly:

```json
{
  "schemaVersion": 1,
  "packageName": "io.agentmux.audioinbox",
  "versionCode": 2,
  "versionName": "1.1.0",
  "apk": {
    "url": "https://link.v1d.io/releases/agentmux-link/phone/app-2.apk",
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
8. Phone and Wear run the same reducer fixtures and produce identical turn,
   playback, target, and update presentation states. Phone physical rehearsal
   is release-blocking. Wear physical device or emulator rehearsal is recorded
   when that milestone is built; unavailable hardware does not delay phone V2.

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
- Tailscale/Public Link reducer parity test result;
- git head, APK path/hash, focused test commands/counts/runtimes, and any honest
  limitation.
