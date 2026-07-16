# Suggestions load safety

All local cron traffic to `https://suggest.v1d.io` uses one restart-safe
circuit ledger at `~/.agentmux/suggestions-http-circuit.json`. The comment
bridge, watchdog outbox consumer and quota push share it.

A network error, HTTP 429 or HTTP 5xx opens exponential backoff. A response
whose public payload says `retryable:false` uses the longer schedule. Only one
half-open probe may leave the host after the deadline. The successful probe
owns a short recovery window so its sweep can finish while other processes
remain paused. HTTP 401/403 stays visible and does not poison availability.

Each caller also receives a stable daily start offset inside a 20-second
window. This spreads minute cron work and prevents every caller from arriving
together after Cloudflare's 00:00 UTC reset.

## Cross-repository scheduling contract

The Node host circuit cannot import the browser/Worker TypeScript module from
another repository. It therefore pins `suggestions-poll-schedule/v1` from
`suggestions-v1d/src/poll-schedule.ts`, including the exact
`poll-attempts-and-board-failures-only` attribution marker. Unit vectors lock
tri-state `retryable`, bounded exponential delay, and jitter below the cap in
both repositories. Policy durations may differ by caller; changing those
shared semantics requires a contract-version change in both repositories.

## Exact rows-read warning

`bin/suggestions-usage-watch.mjs` queries Cloudflare's GraphQL Analytics API
dataset `durableObjectsPeriodicGroups` and sums `rowsRead` across the account.
It does not infer which caller caused usage. The warning explicitly says that
attribution remains unknown until request-level analytics or code proves it.
Cloudflare analytics has ingestion delay, so the configured warning threshold
must leave enough headroom before the operational budget.

Create a Cloudflare token with account analytics read access, store it in the
configured mode-0600 credential file, copy
`suggestions-usage-watch.yaml.example`, and set an explicit daily or monthly
operational budget. The watcher emits a durable, period-and-tier-idempotent
broker alert at `warnAt` and `criticalAt`, and writes the exact snapshot to the
`suggestions-usage` guard heartbeat.

Installation is intentionally separate from code delivery:

```bash
bin/install-suggestions-usage-watch.sh install
```

The default schedule runs at minutes 7, 22, 37 and 52, away from the reset
boundary. Healthy observations are silent.
