# Merge and release

## Merge by fresh proof

6. **Merge by fresh proof.** Just before merge, fetch and rebase on current
   trunk in the allowed checkout. On that exact source run the
   test plan's tests (testing-philosophy.md) and lint, exercise the feature
   by hand, and run one relevant local smoke of at most 5 minutes. A green
   pre-rebase check proves nothing. Visual work: one smallest scenario and
   screenshot.
   Preserve repo correctness and security requirements: never hide a real failure
   or add file-size exceptions to make a gate green; report a required check
   that cannot fit this budget instead of claiming success.
   Release checks follow testing-philosophy.md, the release philosophy and point 8;
   older named chains are not automatically required.
   GitHub-hosted CI is optional evidence, never release authority, no PR
   ceremony for a clean, locally verified change. Deploy by the repo's
   local-first release contract (exact source and rollback SHA, build, live
   check); no duplicate gates. Test the hardest representative case early in
   the actual engine; unit tests cannot close a task while that exercise fails.

## Owners self-merge and self-deliver

7. **Owners self-merge and self-deliver.** A normal green change does not need
   peer review. Human-requested review is welcome; a red gate or high-risk seam
   needs resolution, not a review loop.
   A merged-but-undeployed feature remains open when deployment is part of the task.
   After delivery, or when the work is dropped, the owner removes its worktree with
   `git worktree remove`; the disk cleanup retires pushed leftovers after 24 h.
