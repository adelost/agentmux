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

Released source `cf1c3bab31ca4cb413c190108943b77a98ae3ff1`, version1.25.309, after rebase onto
`c181526d`/1.25.308. Only conflict was the ledger row number: preserve ai:3's68 and assign this work69.

Final proof:151 selected cases across11files in2.81s; strict changed-source lint0. No full repository run.
Immutable install verified578files against that source. The actual installed `amux` executable, with temporary
HOME/config/queue and no model process, admitted four recipients, refused the fifth, then admitted an explicitly
reasoned override with five total jobs and the exact reason in the event ledger.

USR2 was first held for two genuinely active deliveries; both later acknowledged. A fresh check found no physical
write or ATTEMPTING compact. Only then was USR2 sent. Actual heartbeat at10:18:10Z:PID777177,
version1.25.309, sourcecf1c3bab. No SIGTERM or agent/model restart. Runtime ownership released directly to api:3
after the smoke, before this documentation-only closeout. Its later releases are separate.

Private receipts: `~/.agentmux/artifacts/fanout-notices-ai4-20261021/`: `red-valid.log`,
`overlap-red.log`, `unknown-red.log`, `state-race-red.log`, `state-fix-green.log`, `focused-final.log`,
`lint-final-source.log`, `install.log`, `installed-verify.log`, `installed-cli-smoke.json`,
`restart-preflight{,-final}.json`, `runtime-after.json`. Earlier fixture-port mistakes and the fail-closed incorrect
SHA argument are retained in the tool journal; they were not product regressions or bypassed release checks.

Limits: real CLI/State and controller behavior were exercised; Discord posting was replaced at its I/O boundary.
No artificial compact, interrupted pane or provider/model turn was created in the live fleet to manufacture a notice.
Confirmed held notices persist; a rejected Discord send stays eligible for retry. No historical notice replay was attempted.
