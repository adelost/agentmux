# Compact receipts after an account move

Source: Mattias's skyvw:3 request, 27 October 2026 04:48:24Z,
delivery:0e96726374b107981da22470b06246bc. Task104, owner skyvw:3.

## Observed failure

Claw:6 ended work at 26 October 19:34Z with 433,932 context tokens.
The saved VERIFIED receipt was from16:39:01.968Z for session
`01a17580-dd5e-7fa0-b227-48efbacdd59b`. Its cursor addressed the old
`~/.codex/sessions/...jsonl`, while the live process and latest journal
addressed `~/.config/agent/codex-profiles/2/sessions/...jsonl`.

The25,250,564-byte prefix at the cursor is identical in both files:
SHA256 `fd94cf6234c0d94e60c81812b8c15e6235735c1d22924116b3ad25bc0fc93561`.
The old file stops at25,461,633 bytes and16:39:04.523Z. The current file
continues to29,417,064 bytes and19:34:19.705Z. The installed work predicate
finds no work after the old cursor in the old path, and real processed work
after that same boundary in the current path. Despite this,
`contextMaintenanceAttempt` returns VERIFIED and `canAttempt` returns false.
This blocks both the pause and idle automatic compaction routes before they
can evaluate their time/token thresholds.

The owner explicitly permitted a fresh conversation. `/new` was sent once
at27 October04:50Z (delivery:a5c2cffff76906f8d87a536498052085), then the
current-worktree option was selected. The actual terminal shows a blank
Codex welcome and empty composer. The prior rollout and547c STOP receipt
remain. No547c work was restarted. Codex writes a new rollout lazily;
the last-journal lookup alone is therefore not proof of consuming `/new`.

## Required behavior

A receipt must inspect work in the current journal. A path move alone must
neither trigger another paid compact nor let an obsolete VERIFIED receipt
authorize work. Transfer a cursor only after proving the recorded prefix is
the same. A missing or different prefix holds as UNKNOWN. Work a provider
refused does not release the prior fence. Actual processed work does.

## Verification

Read-only inventory at04:56:47Z covered35 configured Codex panes,29 with
a maintenance record for their latest persisted session. Eight records have
a proven copied prefix and processed work only in the current journal:
ai:5, api:4, api:5, api:6, claw:6, lsrc:9, sandman:1 and skydive:5.
All eight incorrectly returned VERIFIED in the installed code. Four more
records use another path but lack a matching prefix (lsrc:3, lsrc:8,
skybar:3 and skydive:7); they are not counted as the same proven failure.
One relocated journal has no new work and correctly retains its receipt.
This is a stored-session inventory, not a historical failure rate or proof
that all those panes are running. No pane was woken by the inventory.

Five new regressions fail before the repair (59 other scenarios pass).
The final thirteen focused files pass254 scenarios; strict changed-file lint
has zero findings. Nightly fixtures now point their observation at their
actual temporary journal, instead of the unrelated `/exact.jsonl`; the
existing no-second-call expectations are unchanged.

The actual-journal replay changes all eight obsolete receipts from VERIFIED
to no current receipt, and idle canAttempt from false to true. The unchanged
copy retains VERIFIED and canAttempt=false. The four unprovable moves return
UNKNOWN and remain ineligible for automatic attempts. This repair neither
rewrites their journals nor guesses the missing cursor boundary. These four
are a remaining limitation; actual processed work after their old receipt
has not been proven by this inventory.

Replay only uses in-memory state, with zero provider calls or pane inputs.
Full private evidence and exact replay command:
`~/.agentmux/artifacts/context-holds-skyvw3-20261027/` (`inventory-before.json`,
`inventory-after-source.json`, `probe-journals.mjs`, `copied-journal-red.log`,
`final-green.log`, `changed-lint.log`).

Code is on master as `f2536c394a809fc92c71bf4475b01001eb4eac82`, release
version1.25.362. Installation and bridge identity are recorded in the same
private evidence directory's `INDEX.md` and `release-proof.json`.

## Full local behavior regression

`channels/auto-compact-account-transfer.test.mjs` uses the production
journal-transfer implementation, durable state and queue, context reader,
automatic poller, pause policy, maintenance and native compact verification.
It observes commands submitted through the composer and resulting context
tokens. Only the terminal/model boundary is simulated; no provider is called.

An unchanged transferred session receives zero compact commands. After its
next completed task at433,932 tokens, exactly one `/compact` is submitted,
its native boundary is verified and the next context reading is40,000.
Constructing another poller over the same state does not repeat the command.

Temporarily reverting only the maintenance repair makes this same test fail:
the submitted-command list is empty instead of containing `/compact`.
Restoring the repair makes it pass. Logs: `transfer-poll-red.log` and
`transfer-poll-green.log` in the existing evidence directory. The later
test/proof commit changes no installed production code.

## Activation

The earlier conservative check refused all95 queued jobs, including those
waiting without submission. Mattias then explicitly requested the normal
bridge restart at27 October05:18:05Z,
delivery:9c7859b284ee57dc4e323de6b5114d6e.

Immediately before the requested restart, all97 open jobs were proven
pending, without submitted/draft/unknown fences, and no maintenance writer
was live. One normal `amux restart` signal was sent; no `--all` was used.
The new bridge is ready, pid4102814, version1.25.362, exact installed source
`726df821b85ae4a06bc7de51002f234fbe385f63`, started05:26:00.496Z.
All97 queued identities and payload hashes survived. Claw:6 still displays
the blank fresh conversation. The quota observer updates again after the
restart, including a check at05:30:12.890Z; its earlier stalled update's
original cause remains unresolved.

The process comparison did find five Claude shell replacements: api:0,
api:2, claw:0, claw:1 and claw:2. Their SessionStart events say resume and
retain exactly the previous UUIDs. The exact startup/recovery trigger was
not attributed; this is not a claim that every pane process stayed unchanged.
Details and pre/post queue proof: `restart-before.json`, `restart-after.json`.
No production compact was forced as a test.
The older quota alert
observer's stale `lastCheckedAt` is a separate unresolved diagnosis; this
change does not claim to explain or repair that incident.
