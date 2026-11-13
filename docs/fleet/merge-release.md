# Merge and release

## Merge by fresh proof

### Push without waiting (every repository)

Panes that wait on each other's gates stall the whole fleet. Panes that push
past each other and mend afterwards keep parallel work possible. So every
repository pushes this way (Mattias 12 Nov 2026 18:5xZ, written down for all
repositories 13 Nov 06:04Z via deep:0; design push-protocol v1,
`/home/adelost/lsrc/.artifacts/cut-flows-deep0-20261109/design/push-protocol.md`):

1. Gates run in the pusher's own worktree, before it takes a place in the push
   line. The line only rebases and pushes; nothing is tested while it is held.
2. A clean rebase keeps the gates' verdict and the push goes. A rebase that met
   another change is mended, the gates of the files that met run again, then
   it pushes.
3. After the push one check runs on the tip: the tests the tip's changed files
   reach. Red on the tip: the pusher mends forward or reverts its change within
   15 minutes. Nobody else waits for it.
4. No trains, no freezes, no peer review of a green change. One owner per row
   merges and releases it.
5. Proof after a release looks like his device: a phone's width and a desk's,
   and a page that stayed open across the release, not only a fresh load.

Measured in Cut's push line (`~/.cache/cutkit-pre-push/queue-log.jsonl`):

| Period (UTC) | Push attempts | Reached master | Share |
|---|---|---|---|
| 12 Nov 12-19, before the rule | 238 | 21 | 9 % |
| 12 Nov 19-24, rule in (cutkit 8dd7543de) | 104 | 80 | 77 % |
| 13 Nov 00-06 | 90 | 82 | 91 % |

Median wait in the line that night 4.5 s; 723 commits reached master in 11 h
with up to 22 panes. Mending afterwards has a cost: two faults reached live and
were found late, a film that did not open at desk width (2 h 20 min, every
proof was at phone width) and a tool row missing on his phone (5 h, every proof
loaded the page fresh). Point 5 answers both.

6. **Merge by fresh proof.** In your own worktree, before taking a place in the
   push line, run the existing targeted tests and lint, exercise the feature by
   hand in the real app, and run one relevant local smoke of at most 5 minutes.
   Write no new test files ([work-ledger.md](work-ledger.md), Code first). A
   clean rebase keeps that verdict; a rebase that met another change reruns the
   gates of the files that met (Push without waiting, point 2). Visual work:
   one smallest scenario and screenshot.
   Preserve repo correctness and security requirements: never hide a real failure
   or add file-size exceptions to make a gate green; report a required check
   that cannot fit this budget instead of claiming success.
   Release checks follow testing-philosophy.md, the release philosophy and point 8;
   older named chains are not automatically required.
   GitHub-hosted CI is optional evidence, never release authority, no PR
   ceremony for a clean, locally verified change. Deploy by the repo's
   local-first release contract (exact source and rollback SHA, build, live
   check); no duplicate gates. Test the hardest representative case early using
   the smallest slice that
   reaches the same failing route in the actual engine, then scale from its
   time/cost receipt within the authorised budget. A small input that bypasses
   that route is not evidence. Unit tests cannot close a task while that exercise fails.

## Owners self-merge and self-deliver

7. **Owners self-merge and self-deliver.** A normal green change does not need
   peer review. Human-requested review is welcome; a red gate or high-risk seam
   needs resolution, not a review loop.
   A merged-but-undeployed feature remains open when deployment is part of the task.
   Worktree lifetime and safe cleanup are owned by [shared-edits.md](shared-edits.md);
   project checkout restrictions still apply.
