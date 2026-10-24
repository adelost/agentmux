# Trackbook consent WIP and the 92b login boundary

Owner api:4. Read-only phase92r received24October2026 at17:25:23Z,
delivery:f599ff198af0d8d1bb7fe47d5f185b15. Budget20min, checkpoint17:35Z,
deadline17:45Z,150%stop17:55Z.92b's separate2h implementation has not started.

## Disposition

The September WIP is an unfinished explicit live-position consent feature,
not a functional prerequisite of the broker login migration. Current main
contains another, partly overlapping live-position implementation. It does
not contain the complete WIP consent model; no old consent requirement is
marked done by this reconciliation.

Recommend one clean92b source copy of current remote main, owned solely by
api:4, leaving historical canonical untouched. No applicable rule requiring
Trackbook work to overwrite that old checkout was found. This is a proposal
for lsrc:3's next routine decision, not an executed checkout or build start.
My earlier inference that canonical cleanup must precede92b has no support in
the actual checkout rules. The proposed clean-source disposition awaitslsrc:3's
decision; it does not silently erase the originally stated consent dependency.
Waiting for an unidentified historical panel adds no proof.

## Source comparison

Base49ffbf33a6528c9c94e422737e2232def971ca38 is12September08:10:45Z.
Current remote main is8d7fd2cd3327db18f87f5cbf7675325dbb7f81dd,
21October21:38:23Z. It includes the later /web-app/ and /map-demo/ edge routing.
The paused branch was created12September08:16:20Z and has no later branch commit.

| Area | Historical dirty intent | Current main | Relation to92b |
|---|---|---|---|
| Live consent | Explicit start/join/share/stop/leave/end, per-member approval and device-bound publication revisions; new session/member tables | No complete equivalent. Main uses owner_latest_positions with scoped PUT/DELETE and a stop tombstone, current friend/replay grants, freshness and account fences | Separate unresolved product behavior; preserve privately, do not merge or claim done |
| Mobile authorization | Adds POST for per-jump shared/session and publication session/revision checks | Main has explicit jumps:write for PUT/DELETE mobile/live/position and jumps:read for live/friends; shared/session is absent | Separate endpoint scope, not a login requirement |
| Replay | Replaces signed replay lease with consent-session projections; suppresses old activity latestSnapshot | Main retains signed shared-session.ts and later per-peer latest points; sharedParticipantStatement helper is absent | Old patch cannot be blindly applied: it omits later replay behavior |
| Snapshot persistence | Adds consent/session/device fields and guards to per-activity snapshots | activity_latest_snapshots remains; newer owner_latest_positions is the separate live path, later contractStore/rest_json retains added wire fields | No need to change either table for broker account linking |
| Shared relation helper | Exports common relation SQL and extracts a final batched statement | Main already exports SHARED_RELATION_SQL by another change; the extracted statement/consent caller is not present | One helper overlaps; this does not establish whole-feature equivalence |
| Tests/schema helper | Adds synthetic consent expectations and loads the uncommitted migration | Main has its own newer replay/live tests and migrations | Source inspected only; no tests were run or declared green |
| Account identity/session | WIP consumes existing owner and app-token authority | hooks.server.ts, auth-links.ts, sessions.ts and Better Auth resolve existing users/auth_links, passkeys and account lifecycle |92b must preserve these identities and sessions; no WIP consent module is needed to add a unique broker link |

The comparison used Git objects for current main, not the paused tree as a
substitute. All9 tracked dirty paths differ from main;6 already have later
main changes. Main's owner-level live path began at e8a1a2f and was extended
by0426ff7/e6e98de/0352c18. No migration state or live data was queried.

References at the pinned main:
[account mapping](https://github.com/adelost/trackbook/blob/8d7fd2cd3327db18f87f5cbf7675325dbb7f81dd/src/lib/server/auth/auth-links.ts),
[sessions](https://github.com/adelost/trackbook/blob/8d7fd2cd3327db18f87f5cbf7675325dbb7f81dd/src/lib/server/auth/sessions.ts),
[live positions](https://github.com/adelost/trackbook/blob/8d7fd2cd3327db18f87f5cbf7675325dbb7f81dd/src/lib/server/live-positions.ts),
[replay](https://github.com/adelost/trackbook/blob/8d7fd2cd3327db18f87f5cbf7675325dbb7f81dd/src/lib/server/group-replay.ts).

## Rules and current resources

Neither canonical nor current-main Trackbook has root or nested AGENTS.md or
CLAUDE.md outside dependencies. No ancestor instruction was found at /,
/home or /home/adelost/lsrc. Both /home/adelost instruction-name files contain
only the9-byte placeholder symlink-. README, product-copy.md,
accounts-and-connections.md and the single-origin runbook govern this product.
They require the same identity store, credential continuity and ordinary
deployment; they do not forbid a clean source copy. A sibling Android repo's
checkout restriction is not inherited by Trackbook.

The applicable AMUX shared-edit rule preserves other WIP and requires one
owned source tree/branch per active feature where permitted.92b has one owner.
Seven existing Trackbook worktrees were inspected as metadata only. The WSL
process/FD snapshot at17:29:40Z identified only a concurrent read-only inspection,
no active writer, runtime or writable open file in those trees. This is a
point-in-time WSL observation, not proof about another host. Current roster
does not assign a Trackbook writer; skybar:1 is stopped, and its21October source
receipt4a1d0ebee01cf02d7174f4f2fd470d00ac3314636fbee6fd4fa9e31d43aab9cf
reports the newer routing, not ownership of the consent feature. No old pane
was woken. Older September notes identify a paused skyvw:5 branch; that is
historical attribution, not a current writer assignment.

## Recommended next decision

1. Assign api:4 as the sole92b writer in a new clean source copy at
   /home/adelost/lsrc/trackbook-92b-api4-20261024, from the existing GitHub
   adelost/trackbook remote's main. Use a single-branch remote clone and one
   named92b branch. Recheck its main SHA before writing; if upstream advances,
   inspect the delta first. No clone is created during92r.
2. A remote clone leaves historical canonical source, HEAD, index and common
   Git metadata untouched. It copies committed source only: no dirty payload,
   track-debug, .dev.vars, .env.local, .wrangler state, account database,
   recordings, browser profile or credential is transferred. It does not create
   another identity store. A linked worktree would also preserve old source
   bytes but writes common Git metadata; the remote clone avoids that effect.
3. Preserve the old consent WIP in place and classify it as unfinished,
   separate from92b. Do not redeploy it or apply its migration. Once the clean
   source choice is recorded, api:4 records92b's file plan/estimate and actual
  2h start before code; checkpoint20min, stop3h. Old Google, passkeys, devices
   and existing users remain; the real account proof still belongs to an
   authorized operator. Legacy removal remainslsrc:0's later console step.

Reversibility: the old tree needs no restoration because it is never changed.
Abandoning the new source copy cannot remove the existing consent bytes or
change production. Any resulting92b source uses ordinary review/release and
its own rollback receipt, not a second product or account owner.

## Private preservation and fallback restoration plan

Private diagnostics are0600 metadata: fingerprints, source comparisons, process
readback and a receipt. No Trackbook source archive, stash, checkout, ref,
migration, live state or secret was modified. The fingerprint manifest
records path, mode, size, mtime, deletion, hashes and original HEAD/index.
There are9 tracked changes (8 surviving files and1 deletion) and7 untracked
files. The latter are the consent migration,3 live-session modules,2 session
route adapters and track-debug.mjs. Their contents are absent from this report
and Git. The early inspection mistakenly printed some untracked TypeScript/SQL
to tool output; that instruction violation was acknowledged immediately. No
track-debug contents were read to output, and no untracked content is pushed.

If a later decision actually requires changing canonical, first authorize and
execute this bounded preservation sequence; none is executed in92r:

1. Recheck the writer/process snapshot and exact HEAD/index/diff/fingerprints.
   Stop on any new writer or bytes. Create an owner-only0700 directory outside
   every repo for the recovery package; archive files0600, never Git/push.
2. Save binary staged and unstaged patches separately, base HEAD/ref/index
   metadata and the9 tracked paths including the deletion marker. Archive all7
   untracked paths with modes, mtimes and symlink identity, including track-debug.
   Do not follow symlinks or copy ignored credential/runtime directories into a
   new app checkout. Existing ignored local configuration remains in place.
3. Read the package back through a second path and compare every file hash,
   mode and deletion against the private manifest. Verify a restore in a
   private isolated source directory at49ffbf3, without starting the product.
   Restore staged patch to index and worktree, unstaged patch to worktree,
   then the exact untracked archive; verify fingerprints again.
4. A shared stash stack is unnecessary on the recommended path. If canonical
   must be switched, an optional git stash create may capture tracked/index
   state without clearing it or changing refs/stash. Keep/export that object
   privately before any cleanup; it does not preserve the7 untracked files.
   Do not use stash -u to put unknown track-debug contents into Git objects.
5. Only after archive/restore verification and the next explicit writer decision
   may exact captured paths be moved/cleaned and canonical switched to inspected
   current main. Recovery reapplies the preserved state at49ffbf3 and restores
   the7 private paths; never apply old consent WIP blindly over new main.

This fallback is more work and risk than leaving canonical intact. It is not
a new implementation prerequisite for92b and is not a completed consent feature.

Private metadata: /home/adelost/lsrc/.artifacts/shared-login-92r-api4-20261024/.
No product tests, live requests, account actions, paid API probes or deployments
were performed in92r. The only published edits are task/report metadata.
