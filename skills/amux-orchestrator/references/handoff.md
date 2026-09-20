# Move work using the existing ledger

Use only for an explicitly requested queue/role/provider migration.

1. Read the latest human source/target/model choices and actors' current work.
   Distinguish job ownership from separately requested model/lifecycle changes.
2. Reuse a ready checkpoint, or obtain one at a safe pause: open rows, decisions
   and original evidence, branch/head/WIP, already-run checks, next step,
   resource ownership and job-specific timers. Preserve journals.
3. Prepare only the chosen recipients. For separately requested Codex model
   changes, use `amux model PROJECT -p N MODEL EFFORT`: exact session,
   compact receipt, live selected model. No raw picker or global latest resume.
4. Send one bounded actionable brief from a file with `--stdin` and a stable
   `--idempotency-key`. Queued is not received: verify the actual first step in
   the receiver's journal before claiming that ownership transferred.
5. End the source's automatic work/timers for the transferred job. Direct
   questions still reach that source and can wake it normally. Do not use
   model-fallback park or channel redirection to represent job ownership.
6. Close the handoff row with source checkpoints, recipient/model evidence,
   actual receiver work and omissions. Inherited product work remains in its
   own ledger; a handoff does not make those product rows complete.

Use the existing workflow. Do not invent a new service/state store or a runtime
handoff API just to test the checklist. Verification is the observed requested
behavior, not a fixed number of tests or an extra approval ceremony.
