# Fleet coordination audit — 2026-07-27

Purpose: keep the current fleet cleanup checkable without turning one manager
pane into a mandatory hub. This is the temporary durable ledger until the
Suggestions board has the simpler self-claim model.

## Current decisions

- Agents may take direct human work or self-claim one READY ticket.
- One feature has one end-to-end owner.
- Project managers observe capacity, blockers, dropped work and duplicates.
  They are not required relays, reviewers, mergers or deployers.
- Dormant panes stay dormant. A task wakes only its exact target.
- Owners use targeted tests and bounded manual proof; no heavy CI by default.
- Normal reporting is one terminal `DONE` or concrete `BLOCKED` outcome.

## Findings and disposition

- [x] **Generated policy still required pane 2 as sole broker.**
  Root cause of `ai:0` unnecessarily pulling `ai:2` into a direct human task.
  Fixed in the policy source, README, drift reminder and focused contract test.
- [ ] **Direct human authority could be shadowed by stale pane memory.**
  New policy explicitly makes current direct instructions outrank manager,
  memory and topology rules. The stale AI memory must be marked historical by
  its owning pane after policy sync.
- [x] **`lsrc:2` interpreted dormant bash panes as missing staff and ran
  `amux reconcile`.** Live process inspection proved panes 5–9 remained bash;
  no work was lost or duplicated. Policy now states that reconcile repairs
  services/shells and is never a staffing command.
- [x] **Skydive refactor wave risked continued polling after completion.**
  All nine milestones are merged/live and the coordinator reports its loop
  stopped. The separate read-only network audit found real future work but did
  not mutate code.
- [x] **Chat Helper ownership is clear.** `lsrc:4` owns Draft Bar end to end;
  `lsrc:2` owns product/architecture decisions. Existing CaptureWidget WIP in
  the canonical checkout is preserved.
- [x] **Skybar cutover has one owner plus one bounded fact check.**
  `skybar:2` owns the cutover; `skybar:3` only answers the requested deployment
  verification. No second implementation lane was created.
- [x] **Skyvw has two related owners.** `skyvw:0` owns menu/JUNK taxonomy;
  `skyvw:1` owns replay/cutaway scene work. They use separate worktrees and
  share only concrete interface facts.
- [ ] **Dormant-pane policy refresh is not yet an automatic one-shot.**
  Hints v1.25.2 syncs at bridge start and the drift guard reminds active panes.
  Follow-up: on the first task after seven days, show one non-blocking
  re-anchor receipt without waking the pane beforehand.
- [ ] **`amux ps` can visually mix configured engine identity with stale
  historical model/output while the live pane is bash.** This contributed to
  the reconcile misunderstanding. Follow-up: render an explicit
  `sleeping/bash` state from process truth.
- [ ] **Suggestions health is split.** A one-shot poll is green
  (`comments/outbox/context/quota`), while `doctor` still reports stale cron
  timestamps and native runtime `:8813` offline. Keep these as health work;
  do not block unrelated feature owners.
- [ ] **The board remains too ceremonial for normal work.** Desired minimum:
  task, priority, owner, state, blocker/reason, last progress, completion
  commit/PR. Agents self-claim; comments route to the owner; a manager only
  sees aggregate exceptions. Preserve history, but remove mandatory broker
  ACK/review from ordinary reversible work.
- [ ] **Large stale worktree inventories obscure live work.** Skydive has many
  historical worktrees and a protected conflicted canonical audio WIP. Cleanup
  must be evidence-based and must never delete dirty or unmerged work
  automatically.

## Project snapshot

- **Agentmux / Source:** policy correction in progress. `lsrc:2` and `lsrc:4`
  continue Chat Helper only; other Source workers remain unassigned.
- **Skydive:** nine-item architecture wave complete and live. New network
  findings are unassigned follow-ups, not hidden implementation.
- **Skyvw:** active menu/JUNK and replay/cutaway polish; no third lane.
- **Skybar:** active old/new deployment cutover investigation.
- **AI DSL:** no active implementation. Stale broker memory/policy is being
  corrected before more work is assigned.
- **API:** no current human asks; leave dormant.
- **Claw:** old paused/recovery lanes remain paused; do not revive them merely
  for status.
