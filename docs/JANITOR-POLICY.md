# Janitor policy: repo hygiene as a decision table

Decided 2026-09-17 by lsrc:0 (pilot owner api:0, on Mattias's request that amux
policy be written as tables).

## What decides

`policies/repo-hygiene.mjs` is the whole rule: touchedToday × kind (merged
branch, unreferenced plan, closed `.agents` ledger row, stale worktree) × age,
eight cells and two invariants. A missing cell, a second cell for a point, a
misspelled value, or a deletion of anything but a merged branch stops the table
from loading, with the point named. To change what the janitor does, change a
cell. Do not add a branch in `core/repo-hygiene-janitor.mjs`.

Each axis value is read from git, tmux or the ledger (`core/repo-hygiene-facts.mjs`).
A fact that cannot be read counts as red and is never guessed.

## How it runs

- `bin/janitor-cron.sh` runs at 23:30 from the installed package, beside dream-cron.
- It writes a report to `~/.agentmux/janitor/reports/<date>.md`.
- It adds one line per acting cell to `~/.agentmux/janitor/ledger.jsonl`, with the cell id, target, SHA and restore command.
- When a repo has anything red, it writes one note on that repo's `ÖPPET NU` line in `.agents/0/TASKS.md`.
- To turn it off, `touch ~/.agentmux/janitor/OFF`.

**Read-only until lsrc:0 lifts it after seven nightly reports.** Every action is
recorded as `would` and nothing in a repo is touched. There is no acting code yet.

## The yardstick (do not re-run the "shorter" test)

The pilot's stop rule asked whether table plus interpreter was shorter than the
hand-written checks. It is not: this morning's manual cleanup was about 40 lines,
and table plus interpreter is 80 code lines (378 with fact reading, report, CLI and
cron). That baseline was wrong. It was a one-off manual run on two repos, with no
report, no restore and no touched check. Any nightly janitor is longer than that,
whether it is a script or a table.

The right yardstick is the decision itself. Today's run, 2026-09-17, measured:

- **Coverage:** the table answers 24 of 24 points in 12 lines of cells and invariants. The manual checks' 5 conditions answered 5 of the 12 kind × age points.
- **Holes:** the manual rules written as cells are refused with 14 uncovered points. Two of those holes held real clutter the manual run skipped silently:
  - 70 CircleKit worktrees, 22 to 49 days old, with HEAD already in main.
  - 19 undated Skyvw plans older than 30 days.
