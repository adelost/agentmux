# Simple Suggestions work loop

Suggestions is a durable shared work list, not an orchestration gateway. Direct human orders still
win. The board never starts, wakes, sleeps, releases, reviews or closes a pane by itself.

## Normal worker loop

1. A new trusted pane runs `amux work join --project <id>` once with the shared fleet key.
2. Run `amux work` to see current work, pending replies, project capacity and up to five approved
   READY tickets.
3. Choose work that fits the current repo context and run `amux work claim TICKET`. The server
   atomically enforces one ticket per worker and at most two active workers per project.
4. Record only meaningful state changes with `amux work working`, `wait` or `block`. Use
   `amux work answer` when the overview says `NEEDS RESPONSE`.
5. After focused local tests and a manual feature check, run `amux work done --tests "proof"`.
   This stores the current commit pointer and closes the exact assignment generation.

## Pane 3 manager sidecar

`skyvw:3` and `skydive:3` keep a light overview. They may create a missing task with
`amux work add "problem and expected outcome"`, then use `amux work approve TICKET` after triage.
Approval is delegated through the local admin token; no GUI is required. Pane 3
may then send a short ticket pointer to a suitable worker, but the worker claims it. Pane 3 is not a
mandatory reviewer and ordinary progress does not route through it.

Silence never releases work. Before an exceptional manual release, pane 3 checks `amux ps`, pane
history and git state, records the evidence on the ticket, and releases explicitly in the UI. No
legacy chat history is imported; the pilot starts with new work only and can be abandoned without
changing existing chat workflows.
