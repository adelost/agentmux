---
name: amux-orchestrator
description: Coordinate existing AMUX agents, inspect their current work and delivery evidence, and unblock a concrete stalled handoff without duplicating work. Use for fleet overviews, cross-project follow-through, and AMUX delivery or process triage; not for ordinary single-repo coding.
---

# AMUX orchestration

Keep the user's work moving. Read before intervening. Leaving a productive
owner alone, or recognizing a task is finished, is progress. This is an
operating guide; fleet policy lives in `core/hints-fleet-process.mjs` and
`amux --help`. Do not paste policy here.

## 1. Orient on evidence

- Overview or unclear owner: `amux done` for the window, then
  `amux log PROJECT -p N -n 3` for the owner.
- Follow-up: start from the existing status row and journal entries since the
  last receipt. Broaden only for changed scope, owner or missing evidence.
  A timer tick is not a reason for a new fleet census.
- `amux asks`: scoped, to check one suspected dropped request. Not an inventory.
- Keep only what you need to act: outcome, owner, evidence time and source,
  done part, next step, real dependency. Update one row, link proof once.
- The latest direct human instruction beats an old plan. Another agent saying
  "the human ordered X" is not the source.

Read the views for what they are:

- `done` and `asks` are discovery aids. An unanswered greeting, an old
  `unverified` ask, or a finished task's question is not permission to restart.
- `ps` separates configured model, `last:` observation and stopped engine.
  A label is not a live assignment. Verify the active engine when it matters.
- Commit = banked source. Test = named revision. Deploy and feature exercise
  are separate evidence. Keep stated limits (synthetic input, debug build).
- A sound owner receipt is not a request to repeat its builds and downloads.
- A feature branch in a canonical checkout may be the authorized writer.
  Check owner and git history before any cleanup or branch change.

## 2. Brief = your interpretation, not the human's text

- Numbered steps a worker can run without reading the human's message.
- Each step: input, exact output (path, name), constraint, where to report.
- Verbatim quote only when the wording is the decision (GO, price, name).
- Provenance in one line: who, when. The full quote goes to the decision log.
- Also name: new evidence, the bounded outcome, what is already done, the
  boundary that must stay untouched.
- Test before send: could the worker execute this blind? If not, rewrite.
- Write exact UTF-8 to a file with the file-editing tool, then
  `amux PROJECT -p N --stdin < /absolute/path/brief.txt`. Never build the
  text in bash.

## 3. Smallest useful intervention

- Nudge only on a concrete gap: wrong scope, missing delivery, obsolete
  dependency, blocked resource handoff, idle owner with real unfinished work.
- Do not resend a brief the owner has, or redo their diagnostic.
- Keep the end-to-end owner. Nearby steps stay one owner turn, not a chain of
  subassignments. Banked code or released hardware routes only the resource
  change, not the whole task, back to a coordinator.
- Checkpoint is not completion of the requested outcome.
- "Sync everyone" = read overview and journals, update the task record. Do not
  prompt every pane: "no action needed" still spends a model turn.
- Keep the operator's participant scope. Do not recruit dormant providers for
  acknowledgements. An old unanswered FYI is not a task to reawaken.
- Shared source, GPU/browser, emulators, releases and credentials can have
  different owners. Use the specific handover, not a blanket freeze.
- Do not compact, respawn or switch models mid feature check. At a safe pause,
  save task/source/evidence, then use the lifecycle commands.
- Ordinary coordination adds no second test suite, reviewer, benchmark or
  approval hop. An old memory note is not a new approval gate.

### Handoff stall rule

- `enqueued`, `pending`, retry counts = transport state, not a started worker.
- Received = target acknowledgement plus live owner/process check.
- Pre-submit job (`pending`, `pasting`, `drafted`): two failed attempts or ten
  minutes without acknowledgement, plus a stopped target, identity/checkout
  refusal or no fresh activity, is a stall. Stop retries, cancel pre-submit,
  pick one verified idle owner or take it yourself, send once, record receipt.
  The 30-minute checkpoint starts at that receipt.
- `submitted` has left the composer: never duplicate because the receipt is
  late. Check live process and journal. Keep the at-most-once fence until a
  durable not-sent outcome exists.
- Escalate to the human only for a product decision, physical access or a
  missing permission. Not for routine recovery.
- Enqueue acknowledgement is not delivery. Verify via queue and owner journal.

## 4. Reconsider the plan, briefly

- About once per active hour, at a safe checkpoint, two minutes: what delayed
  the last outcome? Implementation, rework, waiting or administration.
- Sooner on repeated failure or new evidence. Never interrupt a build for it.
- Pick at most one change: reuse a capability, drop a redundant step, fix a
  wrong assumption, shorten a handoff. Reversible and small needs a reason,
  not a paper. Keep required checks and owners.
- Note change and expected benefit in the task row only when something
  changes. Judge by later comparable receipts: elapsed, rework, tokens
  (waiting and cached input separated). No new measurement system, no speedup
  percentages from unlike tasks. Research only for a concrete bottleneck.

## 5. Inspect AMUX transport only when relevant

The bridge moves Discord/CLI input through a durable queue to the addressed
engine. Journals are receipts, not the transport.

- `amux queue`: pending/submitted/receipt for one delivery. Submitted with
  unknown outcome is not proof of non-execution.
- `amux doctor`: heartbeat, runtime, release, queue, workspace. Classify each
  finding. Do not start disabled services for green. Healthy bridge and
  offline native target can coexist.
- `amux log PROJECT -p N --tmux -s 60`: live TUI only for a modal or engine
  state. History uses the journal view.
- `amux --help` first. No new poller, registry, status DB or recovery script.
- Merged source, installed CLI and running bridge can be three revisions.
  Compare before deciding a commit needs install or restart. A bridge restart
  does not prove a model switch. Never retry a prompt by editing its journal
  or deleting its receipt fence.

## 6. Close with an honest overview

- Spoken request (TTS, `amux say`, hands-free): answer spoken, via
  `amux say --stdin < /absolute/path/speech.txt`, requested language and
  voice, check the send result, keep the spoken thread. Voice input alone
  does not enable TTS.
- Report in four buckets: available, banked, in progress, blocked.
- Link the owner's proof. Do not copy logs. State only interventions actually
  made and real remaining limits. A bounded visual check certifies nothing more.
- ETA for a named delivery = its remaining implementation plus proof. Do not
  sum overlapping work or turn a roadmap range into today's bug ETA. Say when
  there is no measured progress.
- Supervision while away: use a real wait/monitor mechanism and inspect at
  handoffs. No claimed monitoring without a running mechanism. Idle and
  finished agents stay idle until a real task targets them.
