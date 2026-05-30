# Milestones — `amux serve` reliability & correct pane bring-up

> Goal: `amux serve` (or one clear command) brings the whole workspace up with the
> **right number of panes, every agent started, on the right socket** — reliably,
> not "typ".

## ✅ STATUS: ALL DONE (2026-05-30)

Implemented + tested in an isolated worktree — live workspace untouched.

- **Branch:** `milestones/serve-reliability` (5 commits) — worktree at `~/agentmux-milestones`
- **Tests:** 727 passing (713 baseline + 14 new, incl. real-tmux integration tests)
- **Proof:** `amux up --no-serve` on a scratch socket creates ai 5/5, api 8/8, claw 11/11 and warns on claw's mixed schema. Old 80×24 path verified to cap at 2 panes (= the live `ai 2/7` bug).
- **New command:** `amux up` — sync config → create/converge every agent → report drift + orphans → start bridge.

| Milestone | Status |
|-----------|--------|
| M1.1 unify tmux socket (bridge was blind to agents) | ✅ |
| M1.2 `amux up` one-command bring-up | ✅ |
| M1.3 reconcile creates missing sessions | ✅ |
| M2.1 wide session geometry (fixes ai 2/7) | ✅ |
| M2.2 surface pane drift (N missing) | ✅ |
| M2.3 warn on mixed pane schema | ✅ |
| M3.1 auto-sync source→runtime on bring-up | ✅ |
| M3.2 orphan-session reporting | ✅ |
| M4.1–M4.4 jsonl-watcher hardening | ✅ (re-applied after concurrent revert of 1.21.0 on master) |

**⚠ Deploy is YOUR call (workspace-wide):** merge `milestones/serve-reliability` into master, then
restart the bridge / re-run `amux up`. M1.1 also needs the canonical socket = `/tmp/openclaw-claude.sock`
to be where OpenClaw creates sessions (it is today). Note: master reverted the 1.21.0 reactive mirror
while this was in flight — M4 was rebased onto that; review M4 against current watcher before merging.

---

## Diagnosis (live evidence, 2026-05-30)

What's actually true right now:

| Agent | Config wants | Live panes | Status |
|-------|-------------|-----------|--------|
| ai    | 7 (claude×3, codex×2, service×2) | **2** (claude×2) | ❌ under-provisioned |
| api   | 8 (claude×3, codex×2, shell×3)   | 8 | ✅ |
| claw  | 11 (panes:9 + codex×2)           | 11 | ✅ (but schema is ambiguous) |
| lsrc  | 8 (claude×3, codex×2, shell×3)   | 9 | ⚠️ +1 drift |
| skybar| 7                                | not up | ❌ session missing |
| _claw, amux | (not in config) | 3, 1 | ⚠️ orphan sessions |

Two structural facts behind "serve doesn't bring panes up":

1. **Socket split-brain.** Live sessions run on `/tmp/openclaw-claude.sock` (created by
   OpenClaw parent). `amux` defaults to `/tmp/agentmux.sock` (`index.mjs:57`), which has
   **no server at all**. `commands.mjs:2113` uses yet a *third* spelling as fallback.
   `TMUX_SOCKET` is unset in the shell. → `amux serve` targets the empty socket and sees
   zero agent panes.
2. **`serve` never starts agents.** `cmdServe` (`commands.mjs:125`) only does
   `new-session BRIDGE_SESSION 'bash bin/start.sh'` — the Discord daemon. `start.sh` runs
   `node index.mjs`, nothing else. No command anywhere does sync → ensureSession →
   setupPanes → reconcile for all agents. There is no `amux up`.

---

## Milestone 1 — `serve` brings the workspace up correctly  🔴 CRITICAL

The reported bug. Without this, nothing else matters.

- [ ] **M1.1 — Unify the tmux socket.** One canonical default, used by CLI + bridge +
      OpenClaw. Fix the three disagreeing spellings: `index.mjs:57`
      (`/tmp/agentmux.sock`), `commands.mjs:2113` (`/tmp/openclaw-claude.sock`), and the
      unset `TMUX_SOCKET`. Decide canonical (live state says `/tmp/openclaw-claude.sock`),
      then make every default agree. *Root cause of "serve up but no panes."*
- [ ] **M1.2 — Add `amux up` (or make `serve` do it).** One command that: runs sync →
      for each configured agent `ensureSession` + `setupPanes` → `reconcile` to converge
      pane count → then starts the bridge. Today serve = bridge-only.
      **Acceptance:** after a clean `amux up`, every agent in config has a session with
      exactly its configured pane count, on the canonical socket.
- [ ] **M1.3 — `reconcileSession` creates a missing session instead of skipping.**
      `agent.mjs` `reconcileSession` returns `{skipped:"no session"}` when the session
      doesn't exist (`agent.mjs:~594`). Bring-up must `ensureSession` first, or reconcile
      should create it. *Why `skybar` is just absent.*

## Milestone 2 — Pane-count correctness  🟠

- [ ] **M2.1 — Fix silent `split-window` failure.** Detached sessions start at 80×24; a
      4th+ horizontal split throws "no space for new pane" and the loop just
      `console.warn` + `break` (`agent.mjs:493`, `setupPanes`). Resize the window wide
      before splitting (e.g. `resize-window -x 400 -y 120`), or split off the largest
      pane each time, or retry. **Acceptance:** `ai` reaches 7/7, not 2/7.
- [ ] **M2.2 — Surface drift instead of swallowing it.** `paneCountAfterReconcile`
      (`agent.mjs:536`) and `setupPanes` warn to stderr then continue. `amux ps` should
      show `panes: 2/7 ⚠️` so drift is visible, and `amux up` should converge it.
- [ ] **M2.3 — Resolve the dual config schema.** `agentmux.yaml` mixes legacy
      `panes: <number>` (claw) with component keys (`claude/codex/shells/services`).
      `sync.mjs:56` precedence (`config.panes ?? config.claude ?? …`) is implicit and
      makes `panes: 9` silently mean "9 claude panes". Pick one schema, deprecate/convert
      the numeric form, document precedence.

## Milestone 3 — Sync & config hygiene  🟡

- [ ] **M3.1 — Auto-sync on bring-up.** Edits to `agentmux.yaml` (source) don't reach
      `~/.config/agent/agents.yaml` (runtime, what the CLI reads) until `amux sync` is run
      by hand. Wire sync into `amux up` so source is always compiled first.
- [ ] **M3.2 — Orphan-session policy.** `_claw` and `amux` sessions exist on the socket
      but aren't in config. Decide: adopt, kill, or ignore — and have `amux ps` label them
      as orphans so they don't masquerade as managed agents.

## Milestone 4 — Bridge / jsonl-watcher hardening  🟢 (from earlier code review)

- [ ] **M4.1 — Cache parsed config per tick.** `loadConfig` does `readFileSync` +
      `yaml.load` with **no cache** (`config.mjs:20`); a single `checkPane` reads it 3×
      (`findChannelForPane` + `readerFor` + `postTurn`). At 20–30 panes every 5s that's
      60–90 parses/tick. Same hot-path class you already fixed in `amux ps`. Parse once,
      thread the object down.
- [ ] **M4.2 — Parallelize `tick()` across panes.** `jsonl-watcher.mjs:475` does
      `await checkPane` serially; one slow Discord post (chunk pacing + `capturePane`
      footer) blocks the safety-net sweep for all other panes. `Promise.all` (rate-limit
      permitting).
- [ ] **M4.3 — Remove dead params.** `postTurn` takes `fullTurn` + `isFinalSlice`
      (`jsonl-watcher.mjs:197`, computed at `:390`) and never uses them. Leftover refactor
      noise.
- [ ] **M4.4 — `inFlight` drops triggers.** `checkPane` returns early when a check is in
      flight (`jsonl-watcher.mjs:311`); a write during a long post is dropped, relying on
      the 5s poll. Either queue a trailing recheck or document the dependency explicitly.

---

### Suggested order
M1 (socket + `up` + ensure-session) → M2.1 (split fix) unblocks `ai` 2/7 → M2.2/M3
hygiene → M4 perf/cleanup. M1 is the one that makes "run serve, everything's up" true.
