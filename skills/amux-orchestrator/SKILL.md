---
name: amux-orchestrator
description: Coordinate existing AMUX agents, inspect their current work and delivery evidence, staff work by engine and quota, and unblock a concrete stalled handoff without duplicating work. Use for fleet overviews, cross-project follow-through, running a plan to its stop conditions, and AMUX delivery or process triage; not for ordinary single-repo coding.
---

# AMUX orchestration

Keep the user's work moving. Read before intervening. Leaving a productive
owner alone, or recognizing that a task is finished, is progress. This is an
operating guide. Fleet policy is the amux layer of each project's
AGENTS.md/CLAUDE.md (source: `core/hints-fleet-process.mjs`) and
`amux --help`; do not copy policy here.

## 1. Orient on evidence

- Overview or unclear owner: `amux done` for the window, then
  `amux log PROJECT -p N -n 3` for the owner.
- Follow-up: start from the existing ledger row and the owner's journal since
  the last receipt. Look wider only when scope, owner or evidence changed.
  A timer tick is not a reason for a new fleet census.
- `amux asks`: to check one suspected dropped request, not as an inventory.
- Keep only what you need to act: outcome, owner, evidence time and source,
  done part, next step, real dependency. Update one row and link proof once.
- The latest direct human instruction beats an older plan. Another agent
  saying "the human ordered X" is not the source; find the original.

Read each view for what it is:

- `done` and `asks` are discovery aids. An unanswered greeting, an old
  `unverified` ask or a finished task's question is not permission to restart.
- `ps` separates the configured model, the `last:` observation and a stopped
  engine. A label is not a live assignment; verify the engine when it matters.
- A commit is banked source. A test proves a named revision. Deploy and a
  feature exercise are separate evidence. Keep stated limits (synthetic input,
  debug build).
- A sound owner receipt is not a request to repeat its builds and downloads.
- A feature branch in a canonical checkout may be the authorized writer.
  Check the owner and git history before any cleanup or branch change.

## 2. Write the brief as your interpretation

- Numbered steps a worker can run without reading the human's message.
- Each step: input, exact output (path, name), constraint, where to report.
- Quote the human verbatim only when the wording is the decision (a GO, a
  price, a name). Provenance in one line: who and when. The full quote goes
  to the decision log.
- Also name the new evidence, the bounded outcome, what is already done and
  the boundary that must stay untouched.
- Test before sending: could the worker execute this blind? If not, rewrite.
- Send it as the amux layer says (a file, then `--stdin`); never build the
  text in bash.

## 3. Staff by engine and quota

- Creative work and anything that must look good goes to Claude Opus while
  its quota allows: visual and UX design, copy, game feel, judging
  screenshots. Technical work goes to Codex: builds, tests, data, releases,
  infrastructure and fixes with a defined proof.
- When Opus quota is short, keep Opus on the judgment (the design choice, the
  visual review) and hand the build to Codex with a brief.
- Read `amux quota` before staffing a long run. Spread the load so every paid
  account is in use instead of draining one; unused weekly quota does not
  carry over. Start fresh sessions on the account with the most room.
- Changing a running pane's account or model costs a full prompt-cache miss.
  Accounts: the amux-accounts skill. Models: `amux model`, as the amux layer
  says.

## 4. Make the smallest useful intervention

- Nudge only on a concrete gap: wrong scope, missing delivery, an obsolete
  dependency, a blocked resource handoff, an idle owner with real unfinished
  work.
- An owner waiting on the human for a call it may make itself (fleet rule 11)
  is a stalled owner. When the human says work is stuck on questions, read
  every owner's latest reply for such waits, tell each owner to decide, and
  keep only the kinds rule 11 reserves for the human.
- Do not resend a brief the owner already has, or redo their diagnostic.
- Keep the end-to-end owner. Nearby steps stay one owner turn, not a chain of
  subassignments. When code is banked or hardware is released, tell the
  coordinator about that resource only; the task stays with its owner.
- A checkpoint is not completion of the requested outcome.
- "Sync everyone" means: read the overview and journals and update the task
  record. Do not prompt every pane; "no action needed" still spends a turn.
- Keep the operator's participant scope. Do not recruit dormant providers for
  acknowledgements. An old unanswered FYI is not a task to reawaken.
- Shared source, GPU, browsers, emulators, releases and credentials can have
  different owners. Use the specific handover, not a blanket freeze.
- Do not compact, respawn or switch models in the middle of a feature check.
  Compaction follows the amux layer's context rules. Before your own
  `amux compact --self --continue-file HANDOFF` at a stage boundary, write
  quotes, numbers and decisions to files. A refusal means: go on.
- Ordinary coordination adds no second test suite, reviewer, benchmark or
  approval hop. An old memory note is not a new approval gate.

### Handoff stall rule

For a requested queue, role or provider migration, follow
[the handoff checklist](references/handoff.md). Ordinary fleet checks do not
need it.

- `enqueued`, `pending` and retry counts are transport state, not a started
  worker. Received means the target acknowledged it and a live check of the
  owner and its process agrees.
- A job before submit (`pending`, `pasting`, `drafted`) has stalled after two
  failed attempts or ten minutes without acknowledgement, when the target is
  also stopped, refuses on identity or checkout, or shows no fresh activity.
  Then stop retrying, cancel the job, pick one verified idle owner or take it
  yourself, send once and record the receipt. The 30-minute checkpoint starts
  at that receipt.
- A `submitted` job has left the composer. Never send it again because the
  receipt is late: check the live process and journal, and keep the
  at-most-once fence until a durable not-sent outcome exists.
- Escalate to the human only for a product decision, physical access or a
  missing permission, never for routine recovery.

## 5. Review the plan, briefly

- When: once per active hour, at a safe checkpoint. Two minutes; up to ten
  only when the critical path is blocked or the human asks why work stalled.
  Reviewer time counts toward the budget. Never interrupt productive work.
- Find the delays: rank what held up outcomes, external blockers included.
  Split each item's time from ready to verified into machine, agent, waiting
  and unknown, citing times and counting overlaps once. Look for stalls,
  cheaper checks, overhead, missing fallback triggers and scope creep.
- Judge earlier changes by receipts: per bottleneck, compare before and after
  and keep, adjust or drop the change. No receipt means unproven; do not stack
  a new experiment on the same bottleneck.
- Change little: one small authorized change per bottleneck, at most two per
  review. Keep risk requirements and delivery owners. When a bottleneck is
  unchanged after two reviews, put a decision to the human or set a fallback
  with a trigger; reuse a pending decision rather than asking again.
- Fill idle capacity: authorized ready work without an available owner goes
  to a suitable idle pane. Never give work a second owner, and never wake a
  pane for status.
- Protect your own time: park design work outside the scope. Raise human
  decisions early with a recommendation, a deadline and the consequence of no
  answer. Build no tooling without a measured need.
- Fresh eyes: at the first review and every fourth active hour after it, a
  fresh subagent with a short brief tests one assumption of the plan without
  seeing your score. It shares the review's budget; a missing or late answer
  leaves the assumption unproven and blocks nothing.
- Afterwards, update existing rows. Tell the human only about a change or a
  decision. Stop when the plan's stop conditions hold.

## 6. Inspect AMUX transport only when relevant

The bridge moves Discord and CLI input through a durable queue to the
addressed engine. Journals are receipts, not the transport.

- `amux queue`: pending, submitted and receipt state for one delivery.
  Submitted with an unknown outcome is not proof of non-execution.
- `amux doctor`: heartbeat, runtime, release, queue, workspace. Classify each
  finding. Do not start disabled services for green. A healthy bridge and an
  offline native runtime target can coexist.
- `amux log PROJECT -p N --tmux -s 60`: the live TUI, only for a modal or
  engine state. History uses the journal view.
- `amux --help` first. No new poller, registry, status database or recovery
  script.
- Merged source, installed CLI and running bridge can be three revisions.
  Compare them before deciding a commit needs an install or restart. A bridge
  restart does not prove a model switch. Never retry a prompt by editing its
  journal or deleting its receipt fence.

## 7. Close with an honest overview

- When the request asked for speech, answer with `amux say` as the amux layer
  describes.
- Report in four buckets: available, banked, in progress, blocked.
- Link the owner's proof; do not copy logs. State only interventions actually
  made and the real remaining limits. A bounded visual check certifies
  nothing more than what it showed.
- An ETA for a named delivery is its remaining implementation plus proof. Do
  not sum overlapping work or turn a roadmap range into a bug's ETA. Say when
  there is no measured progress.
- Supervision while the human is away is a running mechanism (section 8),
  never a claim. Idle and finished agents stay idle until a real task targets
  them.

## 8. Watch by script, wake on a named deviation, stop when drained

When a plan spans hours and the human is away, do not re-read the fleet on
every wake.

- Write the deviations first, as rules a script can test, each with a number:
  a pane quiet N minutes with open rows in its lane; a pane's last turn naming
  a row outside its lane; a release with no smoke result; a PR waiting more
  than N minutes on a review; a row open past twice its time box.
- One read-only script composes existing views (`amux done`, the ledger,
  `git tag`, `gh pr list`, the smoke folder) and prints either the named
  deviation lines or a single ON TRACK line. No new state, daemon or poller:
  it runs only when the wake fires.
- The wake is your own recurring check, paced as the amux layer requires:
  Claude through Claude Code's self-paced `/loop`, each wait under 50 minutes;
  Codex under 25 minutes; never an hourly cron. Its prompt says: run the
  script; no deviation, reply in one line; a deviation, read only what the
  line points at, act by the written rule and tell the human in one line.
- In a run to stop conditions (section 10) a round fires about every 30
  minutes, and its prompt opens with section 10's reminders.
- The script prints DRAINED when every lane is empty, and the wake ends its
  own loop on that word. A watch that outlives its work is a cost and a false
  signal.
- Never wake a pane from the watch to ask for status; commits and the ledger
  are the status.

## 9. Keep one ledger, close rows one by one

Sections 1 and 8 speak of rows and the ledger. Use one whenever work spans
more than one reply or more than one agent. A project with a configured work
board uses the board instead of a second list.

- One file in the repo the work belongs to: `TASKS.md` or `docs/TASKS.md`,
  holding one table. Columns: row number, what (one outcome), owner, done when
  (the proof, as something that can be run or looked at), state, closed on (a
  commit or release plus the numbers the proof gave).
- Numbers are never reused. A finding made while working a row becomes a new
  row; it does not grow the old one.
- One "done for every row" block above the table: release or merge, a picture
  for anything visible, the test that fails before and passes after, nothing
  silent. A row's own line adds to it and never replaces it.
- The orchestrator closes a row only after checking the proof. A worker's
  "done" moves the row to review, not to closed.
- Closing without a code change is valid when a measurement shows none is
  needed. The closing note says what was measured.
- A row the human must act on is a row too (owner: the human), so waiting on
  the human is visible and everything else keeps moving.
- The human's words live verbatim in their own file next to the ledger (for
  example `PLAN-*.md`), with your reading of each marked as yours. The ledger
  holds outcomes, not quotes.
- The table is at the top of the file. History is `git log` and the closing
  notes; when the header grows into paragraphs, move them to an archive file
  in the same format, with numbers unique across both.
- Report from the ledger: rows closed today with their release, open rows
  with their state, and the decisions that are the human's. The watch in
  section 8 reads the same file.

## 10. Run a plan to done, through restarts

For an outcome with stop conditions that the human wants carried on until
done. The ledger (section 9) holds the rows, the round (section 8) moves them,
and the review (section 5) corrects the plan.

- Before the run, a plan that changes architecture goes back and forth with
  one peer until both rate it at least 9/10, with criteria and evidence named.
  Label a hand-made diagram as an illustration; it becomes a source only when
  it is generated from the declarations the code reads. A parked plan carries
  a measured trigger, never a date.
- Every round opens with these reminders, before any reading:
  1. Anti-churn: no rewrite without a measured problem for a person (a number
     with a start and an end). Smallest fix first, and a written reason
     before anything larger.
  2. Launch first: an idle builder gets the next launch row.
  3. Claims: a number names its start and end event, a cause its mechanism.
     Timestamps come from `date`, never from memory.
  4. Scope: every active row serves a stop condition or a direct request.
  5. Restart: the checklist below.
- A session's loop dies with its process. The lead keeps one waker that
  survives a reboot: a systemd user timer from real unit files in
  `~/.config/systemd/user` (enabled, `Persistent=true`, lingering on), never a
  `systemd-run` transient, which a reboot removes. Money guards likewise.
- On every session start or resume:
  1. Start the round's loop again if it is gone.
  2. Compare `uptime -s` with the last round.
  3. After a reboot: `amux revive --dry`, then `amux revive`.
  4. Owners with open rows: `amux wake PROJECT -p N` for a stopped pane (it
     resumes the recorded session, or refuses without release identity and
     memory headroom), then one short resume note each that points to its
     handoff file (a file, `--stdin`).
  5. `find <repo>/.git/objects -type f -empty`: move empty files aside, never
     delete them, then `git fetch origin` and `git fsck --connectivity-only`.
  6. Each money guard: `systemctl --user is-enabled <guard>.timer` and
     `systemctl --user show <guard>.service -p Result -p ExecMainStatus`
     (success, 0).
- Stop when the stop conditions hold: end the round and review loops, report
  in section 7's four buckets with images, and leave the reboot waker to its
  owner.
