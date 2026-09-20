# Handoff

A handoff transfers specified work, not ownership of the source pane's address.
Use the existing task row and delivery receipts. No new registry, routing layer,
retirement state or universal handoff API is required.

## Execute once

- [ ] Read the latest direct instruction: work, source, successor and model.
      Invalidate unsent briefs that contradict it before sending anything.
- [ ] Save next steps, decisions, repo/branch/SHA, WIP and existing proof at a
      safe checkpoint. Preserve the source's conversation and history.
- [ ] Stop only the source's automatic execution and timers for the transferred
      work before the successor starts writing. Do not stop unrelated work.
- [ ] If a model change was separately requested, use
      `amux model PROJECT -p N MODEL EFFORT` and verify its receipt.
- [ ] Send the checkpoint once using `--stdin` and `--idempotency-key`.
- [ ] Verify that the exact successor accepted and started the right work.
      Queued is not received; an unknown submitted outcome is not permission
      to duplicate delivery. Follow the skill's existing handoff stall rule.
- [ ] Update the existing task row: successor, next step and receipt. Verify
      the original address and reply path using existing evidence or a fixture,
      not a status-only paid model call.

## Binary completion criteria

| At accepted handoff | Required result |
| --- | --- |
| Authorized automatic owner of transferred work | Exactly 1 successor |
| Source's automatic execution/timers for that work | 0 remaining |
| New direct-message rejections caused by handoff | 0 |
| Direct-message redirects caused by handoff | 0 |
| Unrequested address, history, model or lifecycle changes | 0 |
| Checkpoint and recipient acceptance | Both present |

No two automatic writers may own the same work during transfer. Missing proof
leaves the handoff open; it does not authorize reviving the previous owner.
Do not use `parkPane`, pane retirement or redirection to implement handoff.
A direct question to the source is still addressed to the source and does not
reassign its old job. Interactive use can consume the selected model's quota.
Independent model-safety, quota, sleep/wake and compact policies remain in
force. Handoff must not introduce a new blocker; it cannot guarantee a reply
from an offline or quota-limited provider. Repair only incident-created pauses
identified by current evidence, never unrelated or newer pauses in bulk.

## Diagnostics and proof

AMUX-authored messages on this path are English. Preserve quoted user text,
recorded reasons, IDs and provider output. Name the target, observed delivery
state, recorded reason (or "not recorded") and a valid recovery action.
A saved park alone does not prove a model downgrade or stopped process.
Never label an uncertain submission "not sent" or recommend a duplicate.

For the existing model-safety pause, Discord's next regular message accepts
the current model; the blocked prompt is not replayed. Give a pane-specific
`.N //model <model>` hint. CLI uses `amux model PROJECT -p N <model>` or an
explicit `--force`. Do not suggest `/restore` without a known recovery target.
This explains existing admission behavior; it does not authorize new pauses.

Test these observable outcomes, not an implementation's invented retirement
state. Reproduce the symptom before the fix. There is no fixed test-count gate,
blanket import ban, or requirement for two consumers of durable information.
Use the existing focused tests and local policy in `docs/CI.md`:

```sh
npx vitest run core/pane-park.test.mjs test/handlers-durable-target.test.mjs
amux lint --changed --strict
```

These tests cover paused-message diagnostics and target preservation, not an
arbitrary orchestrator's compliance with this checklist. A skill is instruction,
not a runtime security boundary. Verify installed CLI, running bridge and
installed skill separately; a source commit does not clear live pauses or
prove live delivery. Do not report "fixed in use" without the user's actual
message path being verified.
