# Work ledger and queue

## One ledger writer, shared checkouts are mirrors

Every TASKS change in every repository uses the installed `push_ledger.sh`.
It generates the new ledger from fetched origin, commits through a temporary
index, and pushes in one operation. A rejected concurrent push regenerates
above the new origin. It never edits the shared ledger or uses its index.
Do not edit TASKS in a checkout, commit a local-only row, or use a post-commit
merge hook. This replaces the earlier post-commit proposal (sandman:0,
7 Nov 2026 05:14Z, delivery:59ed5b51ec444a587b0012f065e458cc).

The generator reads the latest full ledger on stdin and prints its replacement.
It must change only its own rows. `AMUX_LEDGER_BASE` is the immutable parent SHA;
legacy generators reading origin/master are checked for concurrent ref movement.
For example, save the row transformer outside the mirror, then run:

```bash
push_ledger.sh --repo /shared/repository --path docs/TASKS.md --branch master \
  'docs(ROW): claim or close outcome' python3 /path/to/row-transformer.py
```

Use the repository's actual default branch (`main` for gateway). Huset's existing
`.agents/0/briefs/push_ledger.sh SUBJECT GENERATOR...` delegates to this writer
with its workspace and ledger path. A new checkout gets the same command from
the normal AMUX installation; no Git hook or separate service is needed.

After a confirmed push, the shared mirror advances only with
`git merge --ff-only origin/BRANCH`. The backup uses the same fast-forward
rule. Local edits, a wrong branch or divergence stop the mirror and send an
immediate AMUX alarm to sandman:0 naming the path and Git's blocking files.
A published row remains published even when its mirror stops; do not submit it
again. Repair the named obstruction with its owner, preserving all edits.
Never stash, reset or create a merge commit to make a mirror catch up.

`amux lint REPOSITORY --changed --strict` refuses staged, unstaged and untracked
changes to the repository's configured `TASKS.md` with `LEDGER001`, names `push_ledger.sh` and alarms to
sandman:0. This finding cannot be baselined. Run lint in the normal repository
checks; it also catches a local row unrelated to the selected source diff.
Ledger discovery reuses Stats' `ledger-sources.json` and its `docs/TASKS.md`
default. Reference copies named TASKS-*.md are outside this control.

## Staffing and review economics

5. **A configured board is a shared work list, not an orchestration ceremony.**
   Keep task, owner, state, priority, blocker/reason and completion SHA/PR, in
   the configured project TASKS.md ledger on the default branch, which
   stats.v1d.io reads; a row only on a feature branch is invisible there.
   Above 200 KB, move closed rows verbatim to an archive file beside it (same
   format, numbers unique across both) in one announced commit (Mattias
   31 Oct 2026, delivery:c7932021b8e6e2badf782997ba2c1e40: less context, clear
   focus). The row is one line: state, owner, target with its UTC clock
   (2026-11-04T10:00Z) and proof link. No history in the row; git log has it.
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

8. **Each place has one job.** A row is written at start and at DONE or
   BLOCKED, never at checkpoints. A wait is BLOCKED with what it waits for and
   its UTC clock. No receipt file per step or message: the proof is an image
   link or a SHA in the DONE message. Messages report only DONE, a concrete
   stop or a decision, to the next owner or the person who must act.
   Do not copy other recipients for information.

9. **Record blockers where work is tracked:** a concrete reason and the
   dependency or evidence that clears it, in the board's typed states when
   there is one, never only in a private note. Silence
   is not a worker failure.

## Messages between agents

DONE fits in at most three lines: the change, its key measured result and an
image link or SHA. A stop names the cause and what clears it. A decision
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

## Code first

Time and tokens go to code. Measurement scripts, plans and documentation are
made only when directly needed to deliver or prove a row. No new test files:
the proof is a manual trial in the real app, and the rule has no end date.
The state-age watch reads code commits whose subject names the row, the owner
pane's process and a blocked row's stated clock, never ledger edits; a note
or re-stamp renews nothing. Why: in Cutkit on the night to 4 Nov, 38 of 51
commits were TASKS or docs and 13 were code. Source: Mattias 4 Nov 2026
05:39Z, delivery:2c931a8c583165bff6e83695c6609c03, relayed by sandman:0.

## Time budgets

Each allocated row names a time budget and its target clock when it starts. At the
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
