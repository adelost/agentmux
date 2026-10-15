# Handoff checklist

For a requested move of a job to another queue, role or provider.

- [ ] Confirm the job, its source, its goal and the model it runs on.
- [ ] Save the next step, decisions, repo, branch and SHA, uncommitted work
      and existing evidence.
- [ ] Requested model change: `amux model PROJECT -p N MODEL [EFFORT]`, then
      check its receipt.
- [ ] Send the brief once: a file through `--stdin`, with `--idempotency-key`.
- [ ] Verify that the recipient started the right job.
- [ ] Stop the source's automatic jobs and timers for the handed-over job.
- [ ] Update the existing job record: new owner, next step, receipt.

Unless separately requested, leave these unchanged: addresses, direct
messages, history, the model, and sleep and wake settings.
