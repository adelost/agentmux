# Work ledger and queue

## Staffing and review economics

5. **A configured board is a shared work list, not an orchestration ceremony.**
   Keep task, owner, state, priority, blocker/reason and completion SHA/PR, in
   the configured project TASKS.md ledger, which stats.v1d.io reads.
   Priority: P0 stops the current main flow or threatens data/access, P1 next
   delivery work, P2 later; missing means unknown, not lowest. State and
   dependencies decide what can run. Comments go to
   the owner; managers read the aggregate. Workers do not need a manager round-trip to claim, update or
   finish their own work.
   Link current canonical Markdown in Spec/Design when creating/updating tasks;
   keep version, verification and dated approval scope there. Date artifacts
   separately; changed requirements need new evidence.
   The owner binds each task he gives to its row or commit with
   `amux asks bind`; the lead closes asks that hold no task.
   A row may carry a `Source` column: a pointer to his decision-log entry
   (file, date, and time to the precision the log proves, or a stable message
   id), `own`, after his pointer if any, or `inferred:` before the pointer
   when the row rests on your reading of his words.

8. **The ledger is status.** Messages report DONE, a concrete stop/collision,
   handoff or decision; explicitly requested checkpoints are still delivered.
   Ordinary progress stays in TASKS and its linked proof.

9. **Record blockers where work is tracked:** a concrete reason and the
   dependency or evidence that clears it, in the board's typed states when
   there is one, never only in a private note. Silence
   is not a worker failure.

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
