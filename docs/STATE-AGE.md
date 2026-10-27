# State-age guard, Rule v2

Owner claw:5, task109. Current source: skyvw:0 delivery:ed996c334a2bc70b1a115cb37254248e,27Oct09:53:14Z. The Rule v2 section in `/home/adelost/lsrc/.artifacts/state-age-guard-20261027/DESIGN.md` replaces rules1–4; rules5–7 remain. The earlier whole-line-blame implementation and32/41/80/94message replay are archived evidence, not current policy.

## State clock and routing

The guard streams every first-parent ledger revision through Git and tracks the canonical leading State word. Changes to notes, checkpoints, priority and assigned owners cannot refresh that clock. Losing an owner starts the no-owner clock; open unowned rows use the later of that clock and the latest state transition. Real owner identity is distinguished from a staffing annotation. The existing task parser and board ledger path validation are reused.

Working/review: P0=2h,P1/missing=24h,P2=72h. Blocked=24h. Open with an owner: P0=2h,P1=72h,P2/lower never. Open without an owner:24h at any priority. Translated state names map to the same meaning. Closed rows do not alarm; ambiguous open duplicate IDs remain explicit and unrouted.

Each recipient gets at most one digest per UTC day. Owners see their five oldest overdue rows and the remaining count. Dispatchers see unowned rows, ten oldest remaining entries and totals. A row waiting on an overdue parent is nested beneath that parent. The live and historical paths use the same digest builder and recipient identity. The initial hourly tick with an eligible alarm sends that day's digest; a newly overdue row later that day cannot create a second message.

The actual ps observer also provides bounded journal clocks for the retained idle-owner and unregistered-working checks. All board sources are read for registration; two currently lack explicit age-dispatcher routes and remain visible as unrouted, never guessed. Cutkit dispatches to lsrc:3. The review scheduler's disabled setting is never changed.

## The one v2 replay

Hourly ticks at minute24 UTC,24Oct00:24–27Oct09:24, no sends:

| UTC date | Rows flagged | Recipient digests |
| --- | ---: | ---: |
|24Oct|7|6|
|25Oct|3|4|
|26Oct|28|10|
|27Oct through09:24|29|11|

533c is flagged26Oct23:24Z, before its deadline.557a is flagged26Oct14:24Z but first named in a delivered-digest simulation27Oct00:24Z, which misses the required26Oct mention. The dispatcher had already received its26Oct digest before557a crossed24h. The replay records first detection separately from first actual digest mention; no later rows are retroactively added to an earlier message.

All four days stay at≤12 messages. Ten deterministic flagged rows were checked against raw Git State cells, parents and independent patches over their threshold windows:0of10 had a recent State-word change. These are owner checks, not independent human grading. Historical ps snapshots are unavailable; replay figures cover row-age alarms, while rules6/7 have focused tests and a current ps observation.

Three criteria pass and the557a mention criterion fails. Alarms and the hourly watch stay off as instructed; no second v2 tuning round was run. Evidence: `history-v2-graded.json`, `v2-sample-evidence.json`, `v2-sample-review.json` and the existing task receipt under the design's artifact directory.

## Commands

```
amux state-age replay --project cutkit --since 2026-10-24T00:24:00Z --until 2026-10-27T09:24:00Z --output /private/history.json
amux state-age check --project cutkit --output /private/current.json
amux state-age watch --project cutkit
```

Check/watch default to read-only. Watch checks immediately and hourly without overlapping a slow check. `--send --measurement /private/graded-history.json` requires matching policy/source identity and all four v2 criteria. It refuses the current report. Reservations precede durable queue effects, idempotency preserves submitted/unknown outcomes, and a thirteenth daily recipient identity is refused. Queued is not acknowledged.
