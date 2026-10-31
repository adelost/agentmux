# Work ledger and queue

## Staffing and review economics

5. **A configured board is a shared work list, not an orchestration ceremony.**
   Keep task, owner, state, priority, blocker/reason and completion SHA/PR, in
   the configured project TASKS.md ledger on the default branch, which
   stats.v1d.io reads; a row only on a feature branch is invisible there.
   Above 200 KB, move closed rows verbatim to an archive file beside it (same
   format, numbers unique across both) in one announced commit; State keeps
   the current state, next proof and blocker, not history (Mattias 31 Oct 2026,
   delivery:c7932021b8e6e2badf782997ba2c1e40: less context, clear focus).
   Priority: P0 stops the current main flow or threatens data/access, P1 next
   delivery work, P2 later; missing means unknown, not lowest. State and
   dependencies decide what can run. Comments go to
   the owner; managers read the aggregate. Workers do not need a manager round-trip to claim, update or
   finish their own work.
   Link current canonical Markdown in Spec/Design when creating/updating tasks;
   keep version, verification and dated approval scope there. Date artifacts
   separately; changed requirements need new evidence.
   The recipient of a human order immediately creates or links its TASKS row
   and puts the original delivery-id in the Source cell. Bind that source with
   `amux asks bind`; the lead closes asks that hold no task.
   The `Source` column also retains a pointer to his decision-log entry
   (file, date, and time to the precision the log proves, or a stable message
   id), `own`, after his pointer if any, or `inferred:` before the pointer
   when the row rests on your reading of his words.

8. **Each place has one job.** TASKS holds status and checkpoint updates.
   The existing task receipt holds delivery proof at DONE, release or spending;
   do not create a receipt file for every message. Messages report only DONE,
   a concrete stop or a decision, to the next owner or the person who must act.
   Do not copy other recipients for information.

9. **Record blockers where work is tracked:** a concrete reason and the
   dependency or evidence that clears it, in the board's typed states when
   there is one, never only in a private note. Silence
   is not a worker failure.

## Messages between agents

DONE fits in at most three lines: the change, its key measured result and a
link to the receipt. A stop names the cause and what clears it. A decision
names the question and recommendation. Keep enough facts to act without
opening the link. Shorten words, not evidence or uncertainty.

Omit unsolicited lists of things not done and boundary bookkeeping. Refer to
internal identities with a SHA or a link in prose. Within the assigned outcome
and approved cap, implement the proposal and report its result; involve the
lead only for money beyond the cap, a changed outcome, conflicting owners, or
account and quota decisions. Existing explicit human approval requirements
still apply; already authorised effects do not need approval again.

Why: repeated status messages consume attention and model context without
moving work. Source: Mattias's 25 October decision relayed by lsrc:0,
[TASKS 96](../TASKS.md), with its original delivery source.

## Time budgets

Each allocated row names a time budget and next checkpoint in TASKS. At the
budget, bank the result, finish safe resource closure and report the stop plus
the smallest continuation proposal; do not begin another investigation or phase
without a new bounded decision. Independent assigned READY work may proceed.
Preserve the first estimate and distinguish an approved revision from a guess.
Documented wall time is not measured
active work; unknown work/wait intervals remain unknown.

Why: make overruns visible before spending more time. Source: lsrc:3's
24 October correction, [TASKS 78b](../TASKS.md); original voice not rechecked here.

## A drained backlog is healthy idle

12. **A drained backlog is healthy idle.** On DONE or BLOCKED, re-read the existing queue.
    Re-evaluate conditional deferrals against completed prerequisites.
    Take the next independent READY item already allocated to you; a blocker holds only its
    actual dependents. Stay idle only when no authorised runnable work remains.
