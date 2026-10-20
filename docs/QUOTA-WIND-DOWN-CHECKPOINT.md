# Row 55 checkpoint, api:6

Resumed by api:0 after the 22:16Z reset. Builder only; api:0 owns review, merge, release and live verification.

1. Outcome: push quota wind-down and report to api:0, then stop.
2. Branch: `quota-wind-down`, worktree `/home/adelost/lsrc/agentmux-wt/quota-wind-down`.
3. Design v2: docs/DESIGN-quota-wind-down.md; independent fixture test/fixtures/quota-wind-down-20261020.json.
4. Rebased on origin/master d9d1e4cc (1.25.295). Pure rules, poll, Claude/Codex verified moves, runtime wiring, hints and skill texts implemented. Canonical checkout untouched.

Rebase inspection:
- Conflict-resolved pause poll, quota facts, quota-facts tests and index wiring retain provider identity, paid-credit hold, reading timestamps and candidate snapshots.
- Inspected auto-merged delivery-wake. Wind-down may use the weekly reserve, never paid Codex credits.
- Three credit seam tests failed first: producer queued a spent-account nudge; broker typed one; a previously queued Codex move probed its spent source. Credit-hold precedence now wins at all three seams.
- Dry would-move and operator-request preservation pass. R-2 rapid second-episode logging failed first, now passes; timing stays in the episode map, not a new store.

Verified exact source, 2026-10-21 00:24 local:
- 14 targeted files, 319 tests passed in 6.54 s. Includes the entire affected broker component, quota-park regression, composed move and disabled-move paths. No full repository suite or vitest related.
- Latest `amux churn check`: no reflection due. Existing verdict: `core/claude-quota-coordinator.mjs::createClaudeQuotaCoordinator` SPLIT. Read all four named fix diffs, extracted new move into core/quota-wind-down-move.mjs.
- Latest `AMUX_LINT_BASE_REF=origin/master amux lint --changed --strict`: 15 source files, 15 symbols, 0 findings.
- Replay: first stop 13 panes, second stop 6, both match design v2's independent fixture. `node bin/replay-quota-wind-down.mjs`.
- Generated AGENTS.md and CLAUDE.md both 16384 bytes, measured through ensureAgentHints in a temporary directory.
- Composed path: real poll, broker, store, maintenance, coordinator; external process/quota doubles. Notice -> turn end -> verified compact -> fresh target reading -> exact-session restart -> one MOVED continuation. Move=false compacts without moving.

Design v2, e4a40f85, corrected initial blockers. Additional necessary seams beyond brief's file list: core/account-room.mjs extraction, lifecycle entry without fabricated limit receipt, CLI wind-down request option, source reading timestamps/candidate accounts, index wiring, context admission that prevents a notice consuming its own compact request, immediate turn-end settling, and floor admission allowing the clean-stop nudge to use the reserve. FIFO and the owner's exemption unchanged. Report these additions to api:0.

Limitations for review:
- Claude restart succeeds before MOVED enqueue. A bridge crash between them has no durable move-intent recovery. Notice/nudge restart dedupe is tested; this separate crash window is not closed by that proof. No new recovery architecture invented.
- R-2 move timing is in memory, does not survive bridge restart, matching episode-map ownership.
- External process/quota boundaries doubled. No live pane, tmux socket, account switch, install, version bump or release exercised.
- Pre-rebase lint saw the old handlers.mjs cap 1159 versus trunk 1157. Rebase imported the shrink-only cap and cleared lint; no cap raised.

Evidence:
- Plan and every red receipt: /tmp/api6-quota-wind-down-progress.md. Includes two assertion-only lifecycle stops and the green quoted-launch smaller probe ceb8d0 before the successful retry.
- Final report after push: /tmp/api6-quota-wind-down-report-20261021.txt.
- Acknowledged queue jobs retained seven days, covering the longest episode.

Remaining whole request: final commit/push/report, then api:0 review, merge, installed dry rehearsal, release and live verification.
