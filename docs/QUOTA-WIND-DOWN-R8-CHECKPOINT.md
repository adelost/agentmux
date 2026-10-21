# Row 55 follow-up, api:6

1. Outcome: hold automatic deliveries on unreadable quota; close R-8 durably. Push branch and hand R-8 to api:0, no release/restart/default change. Implementation and local verification complete, commit/push/report below.
2. Branch `quota-wind-down-r8`, fresh from origin/master 41a2c2c5. Canonical checkout untouched.
3. Reset drift already fixed/live by api:0 in 4a08c417, do not duplicate it. Current instructions: api:0 R-8 brief and lsrc:0/claw:2 quota-floor brief, 2026-10-21.

Before-code seam/test plan, component cases under 5 s each, external process/quota doubles only:
- `core/quota-floor-failure.test.mjs`: park continuation and ordinary prompt remain untyped on failed fresh/provider reads; actual facts reader, durable queue and broker. Existing successful room/reset/owner cases remain in delivery-broker.test.mjs.
- `core/quota-wind-down-recovery.test.mjs`: cut after exact restart, new instance poll delivers MOVED once; failed restart cannot block ordinary follower; expired episode still on source cancels without delivery. Actual queue/coordinator/broker, process/profile doubles.
- Queue initial pause is atomic; existing queue tests plus one initial-paused case guard publication before process effects.
- Existing coordinator, lifecycle, pause-compact and composed flow tests guard unchanged session/receipt/idle/target/mode invariants.
- Strict changed lint, churn reflection, diff check. No full suite, no live pane wake or account switch.

Decisions before code:
- A known failed quota response must remain distinguishable from an unsupported pane. Preserve account identity and explicitly mark unavailable facts; a failed fresh read never erases an observed hold.
- R-8 poll belongs to the mover/coordinator tick, before new quota-stage admission: the target account may already have room and the original stage can be absent after the crash.
- Known restart refusal cancels its untouched continuation under the session lease. Broker keeps a paused FIFO-first job ahead of all ordinary followers, so retaining that failed job would deadlock unrelated deliveries. An interrupted/unknown restart stays paused for durable reconciliation, not presumed failed.

Evidence and raw red receipts: appended below before implementation.

- Product RED, 05:21:38 local: `nice -n 10 npx vitest run core/quota-floor-failure.test.mjs`, 2/2 fail. Park continuation and ordinary task both submitted after `network_error`, expected no submitted prompt. Raw receipt a83868 / process 51718, exit 1.
- Root cause: facts reader discarded `ok:false` accounts into null; delivery-wake treated null (also a failed fresh read) as permission. Fix preserves unavailable identity and keeps existing holds. This path could also admit a Codex automatic prompt when its spent-window reading fails; no balance attribution or further tracing attempted.
- GREEN 05:22:36 local: quota-floor-failure + entire affected broker + quota-facts components, 3 files / 89 tests, 4.24 s. Owner exemption, actual reset, account move and Codex credit guards remain green.
- Product RED 05:24:02 local, R-8 three required cases, 3/3 fail: lost MOVED received `[]`, failed retry blocked `ordinary follower`, expired intent stayed `pending` instead of `cancelled`. Raw receipt d4d848 / process 93852, exit 1.
- Product RED 05:25:48 local, 2/2 selected additional boundaries: first FIFO at selection was the ordinary follower, not a paused durable MOVED; selected target was accepted despite the live process using the source home. Raw receipt fbc2f4 / process 9247, exit 1.
- Recovery runs on the existing Claude quota coordinator tick, including when no wind-down stage or mode-on source remains. No new timer or dependency on source quota. Source cancellation uses read-only live process/session/profile proof, even if busy or a limit banner persists.
- Queue API accepts initial nextAttemptAt so the job is born paused, not briefly deliverable between enqueue and update. Existing file cap unchanged at 536 lines.
- GREEN 05:27:38 local: first four R-8 cases and lifecycle profile proof, 24/24 tests, 1.10 s.
- Product RED 05:29:18 local: unreadable Codex account started an idle compact; queued Codex switch ran prepare + source-status; retry after cut restarted twice (expected once). Raw receipt 24f9eb / process 95442, 3/3 selected cases fail. Fix holds unavailable producer/source reads and reconciles existing live-target proof before repeating a restart.
- Strict lint first pass stopped on 9 contract-comment findings (unknown active verbs and missing boundary words), not code behavior. Rewritten to the repository's existing Checks/Defines/Sets/Requests vocabulary; no lint policy edits.
- Strict lint second stop had 2 remaining unknown verbs. Read DEFAULT_WHAT_VERBS, used approved Stores for both; then strict lint passed with 0 findings.
- Churn: coordinator SPLIT, existing recovery fixes read, recovery module extracted. Codex switch newly due (9 commits/7 fixes), all seven fix diffs read, SPLIT: isolated source-quota admission from the switch lifecycle. No cap or policy exception raised.
- Additional coverage, not red-first claims: lifecycle positively proves the target account, and identifies the source process behind a limit even with --continue rather than --resume. Only target release requires exact-session proof; expired source cancellation requires live account proof.
- Authority: docs/TASKS.md row 61 records the separate read-failure bug as blocked on release, per claw:2's newer explicit task-list instruction. Row 55 and api:0's release/default authority unchanged. api:0 handoff queued, not received; existing b3d8a9163aa05ad855004be502be2197 confirmed pending, no submit, no resend. lsrc:0 blocker handoff also durably queued.
- Product RED 05:35:55 local: a failed cached source blocked a pane now proved on an account with room, expected `["follow the moved pane"]`, received `[]` (517261 / process 59180). Recheck live membership before treating unavailable source facts as a hold; unreadable current facts still hold.
- Targeted final-before-this-last-boundary pass: 13 files / 266 tests, 4.53 s at 05:34:27 local. Strict lint 0, churn clear. Replay still exactly 13/6. Default reader with explicit empty env returns dry.

Final product-source verification, 2026-10-21 03:37Z:
- 13 explicit targeted files / 267 tests PASS, 4.70 s. No full suite or vitest related. Whole affected queue/broker/coordinator/lifecycle/poll components included.
- Strict changed lint: 10 source files, 5 symbols, 0 findings. Churn clear, both SPLIT verdicts recorded. Diff check clean. Source still based on latest fetched origin/master 41a2c2c5.
- Composed crash/retry/cancel proof uses real durable queue, broker and coordinator; only process/provider boundaries doubled. Three positive/additional coverage cases are not claimed as red-first proof.
- Separate quota-read fixes ready as e83164d8, 60125612, 5fff73ce. R-8 remains a separate commit. No installed/bridge mutation, pane wake, provider turn or account switch used as a test.
- Read-only live queue evidence: amux queue shows b3d8a9163aa05ad855004be502be2197 pending on api:0's floor; its durable file agrees, no submit fence or submittedAt. This verifies the existing hold, not deployment of these changes.
- CLI diagnostic stop: --limit 20000 was rejected (supported 1..1000); reran the active-job view within that contract, which returned 20 active jobs and the requested pending job. No resend or cancellation.

Handoff report: /tmp/api6-quota-wind-down-r8-report.txt. Whole remaining delivery: api:0 review/merge/release/default decision and installed/live verification; row 61 stays blocked on that release path, not falsely Done. Do not resume old branch or duplicate the reset-drift fix.
