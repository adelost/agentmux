# Dream activity policy

`amux dream` preserves meaningful work without turning nightly maintenance into
a self-waking loop. Context pressure and new work are separate signals.

## Exact algorithm

For each configured Claude pane:

1. Treat recent JSONL mtime only as a cheap prefilter. It never authorizes a
   wake because maintenance also touches JSONL.
2. Read the pane's last successful receipt from
   `~/.agentmux/dream-receipts.json`. On first use, inspect the requested
   `--since` window; afterwards inspect everything after the receipt cursor.
3. Count meaningful user-role turns. Bare `/compact`, dream prompts, recovery
   plumbing and other canonical system noise count as zero. Real human and
   delegated work directives count.
4. Fewer than 10 new turns means no pane write at all: no compact, no dream
   prompt and no wake.
5. At least 10 new turns authorizes a memory update, but only while the live
   pane is exactly idle. Working, modal, missing and unknown panes are skipped.
6. Context at or above 50% adds `/compact` before the memory prompt. Context
   below 50%, or an unreadable context observation, skips compact but still
   writes the memory summary.
7. Advance the durable receipt only after the pane finished and its complete
   bounded marker block exists. The receipt records the newest real turn that
   the run was authorized to summarize. Failures never advance it.

This lets ten turns accumulate across days after a receipt. The same turns can
never authorize another dream, while a heavily used pane still writes memory
after an earlier compact reduced its current context below 50%.

## Sleep boundary

Dream does not stop panes. A sleep controller may consume a successful dream
receipt later, but it must independently prove long idle, no active turn or
modal, an empty delivery queue and safe worktree state. It must never wake a
pane merely to sleep it. Suspected stalls are reported, not killed.

## Rejected alternatives

- Context-only eligibility loses important work after manual or automatic
  compaction.
- A rolling 24-hour turn count can reuse yesterday's same ten turns forever.
- Always compacting every eligible pane wastes time and context when usage is
  low.
- Folding sleep into dream gives one maintenance command destructive authority
  and makes false-idle classification needlessly dangerous.

The V1 boundaries are deliberately fixed at 10 turns and 50% context. A future
change must update this contract and its boundary tests in the same commit.
