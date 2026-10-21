# Row 55 follow-up, api:6

1. Outcome: hold automatic deliveries on unreadable quota; close R-8 durably. Push branch and hand R-8 to api:0, no release/restart/default change.
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
