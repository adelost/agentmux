# Milestones - watcher lego reliability

Goal: make the Discord jsonl watcher reliable under load before re-enabling low-latency reactive posting.

The previous failed fix poked a full watcher sweep for every Stop hook. That made one pane finishing work trigger all panes, which amplified existing load and could starve the bridge. This plan makes the main logic small, pure, and testable, then keeps all IO and runtime wiring outside it.

## Status

Branch: `milestones/watcher-lego`

Live bridge impact: none until this branch is explicitly deployed. Reactive poke is wired behind `AMUX_REACTIVE_POKE=1` and is disabled by default.

## Milestone 1 - Pure watcher engine

WHAT: `core/watcher-engine.mjs` decides what one pane should do from plain data: post nothing, seed checkpoint, post a completed/grace turn, advance an empty checkpoint, or wait for retry backoff.

WHY: checkpoint movement, diff-posting, grace, and retry policy are the fragile rules. They must be unit-testable without Discord, tmux, fs.watch, YAML, timers, or files.

DOES NOT: read jsonl, post to Discord, parse config, schedule work, mutate app state, or know how panes are wired.

Definition of Done:

- Engine API accepts only plain objects.
- First-run seed does not backpost history.
- Complete turns post.
- Active turns are held while jsonl mtime is fresh.
- Grace only fires when both turn end time and file mtime are stale.
- Partial-post continuation posts only new items.
- Failed posts do not advance checkpoint.
- Retry state suppresses immediate repeat work.
- BDD unit tests cover the contract.

Files:

- `core/watcher-engine.mjs`
- `core/watcher-engine.test.mjs`

## Milestone 2 - Bounded watcher reads

WHAT: watcher reads only bounded jsonl tails for normal per-pane checks.

WHY: long sessions can grow very large. A watcher tick should have a known IO budget instead of rereading entire histories during every poll/fs.watch burst.

DOES NOT: change full-history tools that explicitly need history.

Definition of Done:

- Claude watcher path already supports `tailBytes`; adapter passes a bounded budget.
- Codex watcher path supports `tailBytes` too.
- Tail mode still returns the newest turn.
- Tests prove a large old Codex history does not hide the latest turn.

Files:

- `channels/jsonl-watcher.mjs`
- `core/codex-jsonl-reader.mjs`
- `test/codex-jsonl-reader.test.mjs`

## Milestone 3 - Per-pane queue and backoff

WHAT: `core/pane-queue.mjs` serializes work per pane, caps global concurrency, coalesces bursts, and backs off failed panes.

WHY: runtime signals come from polling, fs.watch, and later reactive poke. A burst must become bounded pane work, not a hot loop or an all-pane fanout.

DOES NOT: know about jsonl, Discord, checkpoint semantics, config, or tmux.

Definition of Done:

- 100 signals for the same active pane become first active job plus one trailing job.
- Global concurrency cap is respected.
- Worker retry hints delay the next job for that pane.
- Worker throws also set backoff.
- The watcher adapter uses the queue for poll and fs.watch triggers.

Files:

- `core/pane-queue.mjs`
- `core/pane-queue.test.mjs`
- `channels/jsonl-watcher.mjs`

## Milestone 4 - Thin watcher adapter

WHAT: `channels/jsonl-watcher.mjs` becomes the IO adapter around the engine and queue: load config once per tick, read bounded turns, call engine, post actions, then commit engine state.

WHY: the adapter owns side effects, but policy stays in the pure engine. This keeps tests precise and makes future reactive latency work a small wiring change.

DOES NOT: duplicate engine policy or make global decisions during a pane signal.

Definition of Done:

- Config is parsed once per sweep and threaded through hot paths.
- Reader selection uses parsed config, not a fresh YAML parse per pane.
- `postTurn` reports main Discord-send failure.
- Main-send failure skips footer/recorder and does not advance checkpoint.
- Retry state is persisted.
- Existing watcher BDD tests still pass.
- New adapter BDD test covers fail -> no checkpoint advance -> immediate retry suppressed.

Files:

- `channels/jsonl-watcher.mjs`
- `cli/config.mjs`
- `test/jsonl-watcher.test.mjs`

## Milestone 5 - Reactive poke, but only per pane and off by default

WHAT: Voice PWA exposes `POST /api/poke/:agent/:pane` only when `reactivePoke` is wired by `index.mjs`, and `index.mjs` wires it only when `AMUX_REACTIVE_POKE=1`.

WHY: low latency should be possible without reintroducing the old failure mode. A poke must trigger exactly one pane queue job, never a global sweep.

DOES NOT: edit Stop hooks, enable reactive mode in live bridge, or bypass queue/backoff.

Definition of Done:

- Disabled route returns unavailable behavior by default.
- Enabled route validates agent and pane.
- Enabled route passes `{ name, pane, dir }` to watcher wiring.
- BDD test proves one request pokes exactly one pane.
- No Stop-hook changes in this slice.

Files:

- `channels/voice.mjs`
- `channels/voice.test.mjs`
- `index.mjs`

## Milestone 6 - Verification and deploy gate

WHAT: prove the branch with tests, push it, and leave deployment as an explicit next step.

WHY: shared bridge infra should not be changed by accident. The code can be reviewed and started deliberately.

Definition of Done:

- Focused watcher/voice tests pass.
- Full `npm test` passes.
- Documentation updated with result output.
- Branch pushed to GitHub.
- Live bridge remains untouched unless deploy is explicitly requested.

Files:

- `docs/MILESTONES-watcher-lego.md`

## Test results

Focused watcher/voice run:

```text
vitest run channels/voice.test.mjs test/jsonl-watcher.test.mjs core/watcher-engine.test.mjs core/pane-queue.test.mjs test/codex-jsonl-reader.test.mjs

Test Files  5 passed (5)
Tests       60 passed (60)
```

Full suite after rebasing onto the local master commits that fixed `core/todos.mjs` baseline:

```text
npm test

Test Files  46 passed (46)
Tests       774 passed (774)
```
