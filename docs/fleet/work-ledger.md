# Work ledger and queue

## Staffing and review economics

5. **A configured board is a shared work list, not an orchestration ceremony.**
   Keep task, owner, state, priority, blocker/reason and completion SHA/PR, in
   the repo's canonical ledger (`docs/TASKS.md`, which stats.v1d.io reads).
   Priority: P0 stops the current main flow or threatens data/access, P1 next
   delivery work, P2 later; missing means unknown, not lowest. State and
   dependencies decide what can run. Comments go to
   the owner; managers read the aggregate. Workers do not need a manager round-trip to claim, update or
   finish their own work.
   Link current canonical Markdown in Spec/Design when creating/updating tasks;
   keep version, verification and dated approval scope there. Date artifacts
   separately; changed requirements need new evidence.
   A row may carry a `Source` column: a pointer to his decision-log entry
   (file, date, and time to the precision the log proves, or a stable message
   id), `own`, after his pointer if any, or `inferred:` before the pointer
   when the row rests on your reading of his words.
   The owner binds each task he gives to its row or commit with `amux asks bind`; the lead closes asks that hold no task.

8. **Report only terminal outcomes:** a blocker, collision, handoff or DONE. The board and the ask
   ledger also carry progress.

9. **Record blockers where work is tracked:** a concrete reason and the
   dependency or evidence that clears it, in the board's typed states when
   there is one, never only in a private note. Silence
   is not a worker failure.

## A drained backlog is healthy idle

12. **A drained backlog is healthy idle.** On DONE or BLOCKED, re-read the existing queue.
    Re-evaluate conditional deferrals against completed prerequisites.
    Take the next authorised independent READY item; a blocker holds only its
    actual dependents. Stay idle only when no authorised runnable work remains.
