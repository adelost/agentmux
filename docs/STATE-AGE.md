# State-age guard

Owner claw:5, task109. Sources: skyvw:0 delivery:8e8f4aeec942820a678737c1877bc6db and delivery:73259b19faa1a13cf70a52e5e7c85d2c. Current contract: `/home/adelost/lsrc/.artifacts/state-age-guard-20261027/DESIGN.md`, rules1–7.

The guard reads configured on-track ledger routes independently of whether their review scheduler is enabled. It never enables that scheduler. Cutkit age alarms route to lsrc:3, as its design specifies. Other configured projects retain their named dispatcher. TASKS remains the task state; the guard stores delivery deduplication and recipient reservations, not another work-state machine.

The source is the observed remote default branch. First-parent Git blame supplies the last whole-line change time, including owner/checkpoint changes. Limits are P0=2h, P1/missing=24h, P2=72h, blocked/waiting=24h. Closed entries do not alert. A staffing annotation supplies no owner; real named owners and the dispatcher receive the same row alarm, at most once per UTC day. Numeric timestamps cannot become pane addresses.

Current `amux ps --json` uses the same inspections as normal ps. Bounded current-session journal timestamps supply proven idle/working clocks; missing clocks remain unknown. Working rows whose owner is idle/stopped for2h alert even before their line-age limit. A scoped pane working for1h without a working row anywhere in the configured ledgers alerts only its dispatcher. Unknown project membership is not guessed.

Open duplicate row IDs are reported with their source SHA and lines and left unrouted. A closed archive copy does not hide a unique open row. Historical pane snapshots are unavailable for the requested window, so replay counts below are lower bounds covering row age; rules6/7 have focused behavioral tests and a current ps observation, not invented historical evidence.

## Calibration outcome

Replay24Oct00:24Z–27Oct09:24Z, hourly at minute24, no sends:

| UTC date | Rows flagged | Recipient messages |
| --- | ---: | ---: |
|24Oct|16|32|
|25Oct|20|41|
|26Oct|38|80|
|27Oct through09:24|43|94|

Both required historical probes are missed under the specified rules.533c's whole line was refreshed repeatedly; by27Oct09:24 its last change was08:52:02, age0.53h.557a was P2/open with a72h threshold on26Oct; it became blocked27Oct07:35:55, refreshing its line clock. Whole-line blame cannot establish the intended stalled-state intervals for either probe. Exact states, priorities, SHAs and times are retained in `required-probe-evidence.json` beside the task receipt.

Messaging remains disabled: every day's volume exceeds the under10 requirement, both probes fail, historical pane coverage is missing and two historical snapshots contain ambiguous open row IDs. Original limits were preserved; no alerts were sent and no hourly process/timer was started. Changing the state clock or routing/batching semantics requires a revised design from the contract owner.

## Commands

```
amux state-age replay --project cutkit --since 2026-10-24T00:24:00Z --until 2026-10-27T09:24:00Z --output /private/history.json
amux state-age check --project cutkit --output /private/current.json
amux state-age watch --project cutkit
```

`check` and `watch` are read-only by default. `watch` checks immediately and hourly thereafter, without overlapping a slow check. `--send --measurement /private/history.json` requires matching policy/source identity, complete historical pane coverage, the Cutkit probe hits, no ambiguous open IDs and fewer than10 recipient messages on every calibrated day. It currently refuses activation. Durable reservations precede queue effects and a daily tenth recipient effect is refused; queue idempotency preserves unknown/submitted outcomes through retries. A queued job is not a recipient acknowledgement.
