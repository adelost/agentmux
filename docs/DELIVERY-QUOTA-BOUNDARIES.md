# Delivery and account boundaries, 21 October 2026

Owner api:3. Source api:0's brief after lsrc:0's 08:10Z assignment and
PRIORITIES 2026-10-21 07:47–07:56Z. Base87d09f28 /1.25.304.

Outcomes:
- A: a never-settling shared quota read releases every waiter as unavailable,
  leaves the floor held, and lets the next call read anew. A pre-paste attempt
  never retains its session lease beyond60s; its stage is recorded and a late
  continuation cannot type. Existing physical paste/submit fences remain authoritative.
- B: rotating one eligible pane waits boundedly for its own/session locks,
  without fencing a compacting sibling; refusal names session or pane.
- C: an explicitly requested Codex switch on a confirmed spent5h window skips
  source compact just as a spent week does, preserves the exact session and
  carries an unsent floor-held prompt. Real in-flight delivery still blocks.

Selection before code, targeted invocation cap60s and final selected proof cap300s:
| Changed seam | Nearest existing proof | Guards |
|---|---|---|
| channels/quota-park.mjs | channels/quota-park.test.mjs, never-settling shared read and late response | A: all waiters unavailable, no stale overwrite, next read fresh |
| delivery writer/broker/wake boundary | core/delivery-broker.test.mjs and existing writer/storage tests, controlled unresolved I/O | A: real queue/kernel lease released, stage reason, no late paste or retry of a submit fence |
| session-lease/delivery-queue/account-rotation | core/session-lease.test.mjs and cli/account-rotation.test.mjs | B: held sibling fence allows idle candidate; bounded contention and named lock; compact recheck retained |
| CLI Codex switch and source-window predicate | cli/codex-account-switch.test.mjs and core/codex-limit-recovery.test.mjs | C: spent5h/weekly distinction, zero source compact, verified target/exact session, floor-held versus in-flight job |
| accounts skill/fleet rule | existing hint and accounts rule checks; strict changed lint | Operator switch exception matches code; automatic banner policy not broadened |

Evidence: ~/.agentmux/artifacts/quota-night-20261021/delivery-stall-0754.md.
The historical exact stalled await is unknown: attempt was the last recorded stage.
The source proves that createQuotaParkFacts shares an unbounded read across waiters;
that mechanism is to be reproduced, not asserted as the historical attribution.
The saved event metadata additionally shows no wake_refused after07:54:08Z: later
attempts for both Claude and Codex have no next-stage event before restart. Earlier
Codex attempt counts alone therefore do not show progress during this stall.
The never-settling shared read is now red/green (30s named fake clock): both waiters
receive unavailable, a new call reads again and a late old result cannot overwrite it.
The broker's full pre-paste lifetime, diagnostic stage and late-write guard remain open.
Hotspot SPLIT: quota read lifetime has one small helper; pane fact mapping and the
approved regular-error/last-good policy stay with their existing owner.
No queue text/event detail is printed. Tests use named clock/reader/CLI I/O doubles
and isolated temporary queues, never paid model turns or live account switches.

Release: fresh trunk/rebase proof, strict changed lint, churn/diff, unique305 if
still free, inspect commit contents, install exact fullSHA. A bridge restart is
authorised only through normal amux restart after physical deliveries/maintenance
are clear; verify new pid/version heartbeat. No submitted job is replayed.
