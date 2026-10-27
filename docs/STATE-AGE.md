# State-age guard, Rule v2

Owner claw:5, task109. Current source: skyvw:0 delivery:299efd1fb2f1427f0011d6965e2097bf,27Oct10:30:30Z, adds the first-flagged unowned-row exception to delivery:ed996c334a2bc70b1a115cb37254248e. The Rule v2 section in `/home/adelost/lsrc/.artifacts/state-age-guard-20261027/DESIGN.md` replaces rules1–4; rules5–7 remain. The earlier whole-line-blame implementation and32/41/80/94message replay are archived evidence, not current policy.

## State clock and routing

The guard streams every first-parent ledger revision through Git and tracks the canonical leading State word. Changes to notes, checkpoints, priority and assigned owners cannot refresh that clock. Losing an owner starts the no-owner clock; open unowned rows use the later of that clock and the latest state transition. Real owner identity is distinguished from a staffing annotation. The existing task parser and board ledger path validation are reused.

Working/review: P0=2h,P1/missing=24h,P2=72h. Blocked=24h. Open with an owner: P0=2h,P1=72h,P2/lower never. Open without an owner:24h at any priority. Translated state names map to the same meaning. Closed rows do not alarm; ambiguous open duplicate IDs remain explicit and unrouted.

Owned rows retain one digest per recipient per UTC day. Newly overdue rows without an owner panel go to their dispatcher immediately in that tick, once per row; rows first flagged together are batched into one dispatcher message. Owners see their five oldest overdue rows and the remaining count. Dispatchers see unowned rows, ten oldest remaining entries and totals. A row waiting on an overdue parent is nested beneath that parent. The live and historical paths use the same digest builder and recipient identity. The first hourly tick with owned alarms sends the daily digest. A later tick may add a dispatcher message containing only newly overdue unowned rows. Durable row receipt keys suppress later repetitions, and existing queue metadata recovers those receipts if local bookkeeping was interrupted.

The actual ps observer also provides bounded journal clocks for the retained idle-owner and unregistered-working checks. All board sources are read for registration; two currently lack explicit age-dispatcher routes and remain visible as unrouted, never guessed. Cutkit dispatches to lsrc:3. The review scheduler's disabled setting is never changed.

## Final replay after the authorized unowned-row correction

Hourly ticks at minute24 UTC,24Oct00:24–27Oct09:24, no sends:

| UTC date | Rows flagged | Recipient digests |
| --- | ---: | ---: |
|24Oct|7|6|
|25Oct|3|5|
|26Oct|28|12|
|27Oct through09:24|29|11|

533c remains flagged26Oct23:24Z.557a is detected and named26Oct14:24Z, in the same tick, including dependency nesting. The earlier v2 trial named it27Oct00:24Z; that failure remains in the archived report. Message totals are6/5/12/11 and every day stays within12.

The state clocks and limits were unchanged. The deterministic sampleHash and all ten sample records exactly match the earlier independent raw-Git evidence:0of10 State words changed within their limit. This is owner review of immutable Git evidence, not independent human grading. Historical ps snapshots remain unavailable; rules6/7 retain focused tests and use actual current ps observations.

All four final replay criteria pass. Evidence: `history-unowned-graded.json`, `unowned-sample-review.json`, `unowned-red.json`, `unowned-final-tests.json` and the existing task receipt. The requested Cutkit timer may now be activated after installed-source verification. Its hourly oneshot fetches Cutkit's origin before reading the default branch, and uses the same qualified report. Actual activation and queued-job receipts live in the delivery receipt; no classifier trial is part of this service.

## Commands

```
amux state-age replay --project cutkit --since 2026-10-24T00:24:00Z --until 2026-10-27T09:24:00Z --output /private/history.json
amux state-age check --project cutkit --output /private/current.json
amux state-age watch --project cutkit
```

Check/watch default to read-only. Watch checks immediately and hourly without overlapping a slow check. `--send --measurement /private/graded-history.json` requires matching policy/source identity and all four replay criteria. The final unowned-row report qualifies. Reservations precede durable queue effects, idempotency preserves submitted/unknown outcomes, and a thirteenth daily recipient identity is refused. Queued is not acknowledged.
