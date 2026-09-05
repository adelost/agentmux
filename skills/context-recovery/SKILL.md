---
name: context-recovery
description: Recover a prior decision or interrupted task from durable memory and original conversation evidence. Use after lost context, contradictory history, or questions about what was agreed; not for ordinary self-contained questions or fleet scheduling.
---

# Recover the decision, not the whole transcript

Identify the current requested outcome before searching. Keep three sources
distinct: current instructions control actions; a task checkpoint describes
observed progress; historical notes record what used to be true. A summary or
search rank does not establish current permission, ownership or completion.

## Resume an interrupted task

1. Use the supplied compaction summary and the current human request. In AMUX,
   `amux done` identifies the current pane and the next journal command.
2. Read that pane's last relevant turns with `amux log PROJECT -p N -n 3`.
   Do not use a global "last session" belonging to another engine or person.
3. Recover the minimum state: outcome; latest decision with source/time;
   completed portion and evidence; remaining next step; real dependency;
   current owner/source checkout; authorized effects and rollback boundary.
4. Verify mutable facts at their owner (Git, process, release receipt or task
   store) before acting. Do not repeat a completed step because an old note
   said "waiting", or resend a prompt whose post-submit outcome is unknown.

If the latest request changes direction, explicitly supersede the relevant
old plan. Do not silently carry old approval requirements into the new task.

## Find an earlier agreement

Start with specific distinguishing words, names, identifiers or dates:
`amux search "specific terms"`. Follow a relevant hit with
`amux search --show N`, or its source-path/line drilldown. If lexical search
misses a paraphrase, use the existing `--semantic` mode. Use `--deep` only
when current memory/digests and bounded journal reads are insufficient.

For exact wording or authorization, inspect the original human message plus
later relevant corrections. `amux asks --grep "topic"` and a scoped
`amux log PROJECT -p N --grep "term"` can locate those. Read both sides of a
conflict before classifying it. A newer unrelated note does not supersede an
older decision; preserve scope and explain what changed.

When retrieval is incomplete, report what was searched and what remains
unknown. Ask one precise question only if that missing fact prevents safe
progress. Never substitute a plausible memory or invent a quotation.

## Keep the next recovery small

Use the task's existing durable record; do not create a second backlog.
At a meaningful milestone or before a supported compact, update a concise
checkpoint with the seven state items above and links to evidence. Store
large logs, timing tables, images and failed experiments outside the digest.
Keep original history recoverable. Mark replaced decisions as superseded
with a pointer to their replacement, not as a second active instruction.

Daily notes are an index/digest, not mandatory wholesale startup input. Read
their summaries/headings and sections relevant to this request; current
workspace instructions determine the exact memory policy. User preferences
and durable cross-task decisions belong in the workspace's maintained index.

Use native compaction as supported by the engine. Do not hand-edit encrypted
compaction data, trim the middle of a live journal, or treat log housekeeping
as a substitute for saved decisions. A compact receipt is not proof that all
important facts were retained: verify the next task can resume from its record.

## Evidence boundary

A passing linter proves only its checked constraint. A Dream start proves no
digest was saved. An uploaded screenshot proves no animation is smooth. Keep
source, observed behavior and judgment distinct; preserve their limitations.
