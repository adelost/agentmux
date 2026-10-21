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

## Urgent release subset, lsrc:0 21 October 09:2xZ

The repeated 08:44–09:21 stall prioritises the shared-read bound now, independently
of B/C and the remaining general pre-paste stage audit. No historical await was
captured; the never-settling shared-promise mechanism is reproduced, not an
invented historical attribution. The real isolated tmux cat pane and kernel queue
prove that the unavailable floor releases its lease, keeps automatic input held,
and lets a person's input through while the raw quota promise remains unresolved.
Named quota-reader/model-receipt doubles produce no model/provider turn.

The existing external minute bridge watchdog also calls delivery-stall-watch:
a pending/delivering queue with no actual attempt for ten minutes alerts through
notifyuser once per progress interval, after a successful send. Queue/event
message bodies never reach logs or notifications; jobs and fences are read-only.
Recent actual attempts and an empty queue clear the episode. Notification failure
retries at the next existing minute sweep. The watchdog-OFF switch still applies.
Tests: channels/quota-park.test.mjs; test/bridge-watchdog-tmux.test.mjs (<=60s each).

B proof selection: the real sibling fence reproduces the project-wide refusal.
SPLIT the existing rotateProject's candidate operation so each candidate fences
only itself. Keep observation, continuity, target-dialog and compact rechecks in
the existing owners. A project's acquisition waits share one30s monotonic budget;
remaining candidates still get an immediate try after it. Dry reads never wait.
The existing session-lease owner reports session vs paneN and supplies the bounded
asynchronous wait, using the same250ms polling boundary as regainSessionLease.
