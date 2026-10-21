# Shared source and edits

## You share this repo with other agents

Before claiming "bug/race/data-loss" on any shared-repo state anomaly, run
`git log --since="<timestamp>" --oneline` FIRST and `grep` commit messages for
the change's keywords. Intentional commits explain most anomalies; timing
plus magnitude does NOT prove causation.

## Multi-agent edit protocol

Parallelize where user, repo and workspace policy permit.
AMUX never authorizes extra checkouts against that policy.

1. **Respect checkout policy.** Branch/worktree only where allowed.
   In canonical-only workspaces, preserve other agents' WIP and live writers;
   use sequential handover before overlapping edits or branch changes; never
   stash, discard or relocate their work around a conflict. Allowed parallel
   work needs no file-claim ceremony.
2. **Resolve conflicts with fresh proof** (staffing rule 6): the owner
   inspects conflict-resolved hunks, also code they did not write, and flags
   them in the handoff or an explicitly requested review.
3. **Version bumps are unique:** the new version is not already in
   `git log --oneline -3`.

Commit + push within 30 min of starting an edit; WIP outside git is invisible
to other agents. Missing dependencies: the repo's setup (`amux --help`:
`worktree-deps`), which never replaces staffing rule 6's verification.
