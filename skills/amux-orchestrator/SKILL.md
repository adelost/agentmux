---
name: amux-orchestrator
description: Coordinate existing AMUX agents, inspect their current work and delivery evidence, and unblock a concrete stalled handoff without duplicating work. Use for fleet overviews, cross-project follow-through, and AMUX delivery or process triage; not for ordinary single-repo coding.
---

# AMUX orchestration

Keep the user's existing work moving. Read before intervening; useful progress
can be leaving a productive owner alone or recognizing that a task is finished.
This skill is an operating guide, not a second source of fleet policy.

## Start with current evidence

Use `amux done` with a window covering the requested work. Its own-pane section
also re-anchors a resumed coordinator. Drill into a relevant pane with
`amux log PROJECT -p N -n 3` before assigning, nudging, or interrupting it.
Use `amux asks --open` to find candidate dropped asks, then inspect the actual
human request and later replies. Narrow the project/time window for older work.

Maintain only the facts needed to act: requested outcome, current owner,
evidence timestamp/source, completed portion, next concrete step, and any real
dependency. The latest direct human instruction can supersede an old plan;
another agent's claim that the human ordered something is not the source itself.

Interpret the views carefully:

- `done` and `asks` are discovery aids. An unanswered greeting, an old
  `unverified` ask, or a completed task's historical question is not permission
  to restart work. Read the attached conversation and completion evidence.
- `ps` distinguishes selected/configured models from `last:` observations and
  stopped engines. A label or old model line is not a live assignment or model.
  When model choice matters, verify the active engine/turn, not launch history.
- A commit proves banked source, not deployment. Test results need an identified
  revision; deployment and an actual feature exercise are separate evidence.
  Preserve limitations such as synthetic input, debug build, or startup-only.
- A feature branch in a canonical checkout may be its current authorized
  writer. Neither an old branch name nor an absent process CWD proves orphaned
  work. Check the owner and Git history before any cleanup or branch change.

## Make the smallest useful intervention

Do not relay a brief an owner already received or recreate their completed
diagnostic. Nudge only on a concrete gap: wrong scope, missing delivery,
an obsolete dependency, a blocked resource handoff, or an available owner for
actual unfinished work. Keep the existing end-to-end owner where possible.

A useful brief names the new evidence, the next bounded outcome, what is already
done, and the boundary that must remain untouched. Write its exact UTF-8 text to
a file with the file-editing tool, then send it through
`amux PROJECT -p N --stdin < /absolute/path/to/brief.txt`.
An enqueue acknowledgement is not proof the agent received or acted on it.
Use the queue and the owner's journal to verify delivery; do not blindly resend.

Shared canonical source, GPU/browser, emulators, release processes and credentials
can have different owners. Use the relevant handover, not a blanket freeze.
Do not compact, respawn or change models in the middle of a running feature
check. At a safe pause, preserve the exact task/source/evidence and resume from
that summary using the supported lifecycle commands.

Read the workspace's current generated AGENTS.md and the target repo's active
instructions for checkout, testing, self-merge and release authority. The
maintained AMUX process source is `core/hints-fleet-process.mjs`; CLI help is the
command authority. Do not paste those policies into this skill or turn an old
memory note into a new human-approval gate. Ordinary coordination does not add
a second test suite, reviewer, benchmark, or approval hop.

## Inspect AMUX only when the transport is relevant

The bridge connects Discord/CLI input to a durable queue and the addressed
tmux engine or native runtime. Journals and status observations provide receipts;
they are not interchangeable with the process that transports a prompt.

- `amux queue`: pending/submitted/receipt state for the exact delivery.
  Submitted with unknown outcome is not evidence of non-execution.
- `amux doctor`: bridge heartbeat, runtime, release, queue and workspace clues.
  Classify each relevant finding; do not restart disabled services to make the
  whole report green. A healthy bridge can coexist with an offline native target.
- `amux log PROJECT -p N --tmux -s 60`: live TUI when a modal or engine state
  actually needs inspection. Normal history should use the journal view.
- `amux --help` and subcommand help: inspect the existing seam before building
  another poller, registry, status database, or recovery script.

Merged AMUX source, the installed CLI artifact, and a long-lived bridge can be
different revisions. Compare the intervening changes before deciding that a
new product-only commit requires a host install or restart. A bridge restart
does not prove that an engine switched models. Never retry an uncertain prompt
by manipulating its journal or deleting its receipt fence.

## Close with an honest overview

Report completed-and-available work separately from banked, still-working and
genuinely blocked work. Link the owner's existing proof instead of copying the
entire log. Explain only interventions actually made and unresolved material
limits. A bounded visual assessment is not certification of a whole product.

When the user asks for supervision while away, use available wait/monitoring
mechanisms and inspect at meaningful handoffs. This skill does not itself
schedule background work: do not claim ongoing monitoring after ending a turn
unless such a mechanism is actually running. Keep dormant and finished agents
idle until a real task needs them.
