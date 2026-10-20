# Row 55 checkpoint, api:6

Resumed by api:0 after the 22:16Z reset. Current instruction: rebase on current origin/master, preserving the Codex credit hold and wind-down behavior. Builder only; api:0 owns merge, release and live verification.

1. Outcome: quota wind-down implementation pushed for api:0 review. api:0 owns merge/release/live verification.
2. Branch: `quota-wind-down`, worktree `/home/adelost/lsrc/agentmux-wt/quota-wind-down`.
3. HEAD: `808944fe`, pushed to `origin/quota-wind-down`. Contains pure decisions, shared account-room ordering, historical replay and tests.
4. Integration is banked before rebase: Claude/Codex verified moves, runtime wiring, hints and skill texts. Canonical agentmux checkout untouched.

Resume interval, read-only only:
- Ran memory orientation, read checkpoint/WIP and relevant code. No implementation, tests, commit or push during this interval.
- Fetched origin. Current origin/master `b7058a16` (rules-lint release 1.25.291); HEAD remains `808944fe`. Ten new trunk commits since design v2, no overlapping source paths in the diff. Rebase still required after WIP commit.
- Checked queue retention: acknowledged jobs kept seven days, covering the wind-down episode's seven-day maximum window.
- Remaining audit items: dry would-move test, pending Codex operator request preservation, Claude continuation crash gap after successful restart but before enqueue. Current code enqueues MOVED only after restart succeeds. No new scheduler/store designed or added; api:0 owns design departures.

Verified before stop:
- 12 targeted files, 209 tests passed at 19:54:13 local. Files: core/quota-wind-down.test.mjs, core/quota-wind-down-replay.test.mjs, channels/pause-compact.test.mjs, channels/quota-park.test.mjs, channels/idle-capacity-runtime.test.mjs, core/claude-quota-coordinator.test.mjs, core/claude-quota-lifecycle.test.mjs, cli/codex-account-switch.test.mjs, core/context-maintenance.test.mjs, channels/quota-wind-down-flow.test.mjs, test/agent.test.mjs, test/hints-budget.test.mjs.
- Additional broker floor group: 5 passed, 77 skipped at 19:55:59. New 3 % nudge test failed before floor exception, then passed.
- Latest `amux churn check`: no reflection due. Existing verdict: `core/claude-quota-coordinator.mjs::createClaudeQuotaCoordinator` SPLIT. Read all four named fix diffs, extracted new move into core/quota-wind-down-move.mjs.
- Latest `AMUX_LINT_BASE_REF=origin/master amux lint --changed --strict`: 15 source files, 15 symbols, 0 findings.
- Replay: first stop 13 panes, second stop 6, both match design v2's independent fixture. `node bin/replay-quota-wind-down.mjs`.
- Hints budget passes after cutting 6 bytes in rule 3. Observed before cut 16390 bytes, expected now 16384; standalone final byte-count report still needed.
- Composed path: real poll, broker, store, maintenance, coordinator; external process/quota doubles. Notice -> turn end -> verified compact -> fresh target reading -> exact-session restart -> one MOVED continuation. Move=false compacts without moving.

Design v2, e4a40f85, corrected initial blockers. Additional necessary seams beyond brief's file list: core/account-room.mjs extraction, lifecycle entry without fabricated limit receipt, CLI wind-down request option, source reading timestamps/candidate accounts, index wiring, context admission that prevents a notice consuming its own compact request, immediate turn-end settling, and floor admission allowing the clean-stop nudge to use the reserve. FIFO and the owner's exemption unchanged. Report these additions to api:0.

Resume verification, 2026-10-21 00:18 local:
- Same 12 targeted files, 209 tests passed in 1.79 s before rebase.
- Current origin/master d9d1e4cc adds 58e1a3a9's paid-credit hold and a185ec6f's forecast-reset fix. Overlapping paths require explicit reconciliation, not choosing one side.

Next steps:
1. Read this checkpoint and `/tmp/api6-quota-wind-down-progress.md` (test plan, individual reds, two assertion-only lifecycle stops and their smaller-probe receipts).
2. Inspect WIP and current trunk. Finish focused adversarial check, especially continuation crash boundary, dry would-move path and new intent vs pending Codex operator request. Do not invent design changes.
3. Fetch/rebase allowed branch on current origin/master. Run the exact-source targeted set above plus broker floor group, lint and `git diff --check`; no full suite or vitest related.
4. Measure generated hints bytes, capture replay output, finish each-red report. Before commit run `amux churn check`; any new hotspot needs source/fix-diff reading and verdict. Never raise lint caps.
5. Explicit-path stage, commit, push. Complete report to file, send once: `amux api -p 0 --stdin < /absolute/path/report.txt`. No merge, release, version bump, live pane action or account switch.

Remaining whole request: rebase, remaining adversarial checks, final exact-source verification, push and complete report.
