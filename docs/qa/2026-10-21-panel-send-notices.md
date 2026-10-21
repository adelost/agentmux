# Panel sends and held notices

Lsrc:0's21Oct execution brief: enforce the existing contact-only-action-owners policy with four distinct panel
recipients per sender in15minutes, a reasoned `--fanout` escape, and one held-compact notice per pane/episode.

Implementation keeps existing authorities:
- Actual CLI dispatch/configured sender detection, existing atomic State admission, then the existing queue.
  Operator/Discord and the internal watchdog use their existing paths. Dispatcher `lsrc:0` and self-sends exempt.
  No new transport or scheduler. An admission counts an attempted recipient, not a delivered/completed job.
- Stable cause and context-session identity, accepted-notice persistence through existing State, a local in-flight
  fence for overlapping polls. Unknown context alone never clears an episode. A failed Discord post still retries.
- The cohesive send command and held publisher are extracted; the large command module's size cap shrinks.

Test plan, focused and offline:
- `cli/panel-send.test.mjs`: actual dispatch→real temp queue/state; fifth target denies before enqueue,
  explicit exception reaches audit, blank reason refuses. Component, about0.1s.
- `core/panel-fanout.test.mjs`: repeated recipient/15min expiry, independent senders/exempt origins,
  two real processes racing the last slot under State's existing lock. Component, about0.2s.
- `channels/auto-compact-held.test.mjs`: actual poll with temp config/journal and fake Discord; unchanged cause
  across journal activity/reload, changed/cleared episode, overlapping polls and missing context. Component, about0.1s.
- Existing auto-compact core/controller, sender/flags, CLI dispatch/help and focused selector checks retained.
  Two raw-archive CLI fixtures failed identically on unchanged12c7d8bd because they omitted `--raw` afterf568d7c0
  moved the default to posted conversations. The fixtures now select their documented legacy port; assertions retained.
- The real two-process admission test exposed an existing State constructor race: it read old content, then
  could stamp a newer atomic writer's inode as already read. The deterministic file-I/O boundary case fails on
  that lost update. Reading the initial stamp before content lets the existing locked mutation reload the new file.
  State's API, lock and write path stay unchanged; its existing component and new boundary case run together.

Original red receipts: fifth recipient created5jobs, same interrupted cause posted3notices, overlapping polls2,
and an unknown context reading rearmed an unchanged cause. Targeted tests and strict changed-file lint qualify
the source; no provider/model or active-fleet message is a test double.

Release receipt: pending fresh-trunk selection, unique version, immutable install and actual bridge identity after USR2.
