# amux memory

## Current design (2026-09-09)

AMUX owns deterministic collection, bounds, receipts and atomic writes. One
operator-selected AMUX pane owns the nightly editorial judgment. No hidden
one-shot model process may edit memory.

The configured pane lives in source `agentmux.yaml`:

```yaml
dream:
  agent: claw
  pane: 3
```

The full execution and failure contract is in `docs/DREAM-POLICY.md`.

## Commands

```text
amux dream                  # visible configured-pane fleet digest
amux dream --dry            # source inventory + exact prompt, no side effects
amux memory status          # sizes, warnings, backlog and latest run
amux memory context         # small dated references, no diary contents
amux memory context -p project:3 --json # exact pane commands + file versions
amux memory lint [--json]   # read-only policy findings
amux memory compact --dry   # inspect old daily-file compaction candidates
```

Non-dry `amux memory compact` is deliberately disabled. Its former default
spawned a separate model process that could rewrite memory without a visible
AMUX prompt. Old files remain intact and searchable; lint keeps the backlog
visible until a similarly transparent, operator-owned curation flow exists.

## Nightly chain

```text
configured owner exact /compact
  -> visible Dream prompt
  -> isolated validated summary
  -> immutable Markdown snapshot + atomic daily reference
  -> read-only memory lint
  -> incremental search reindex
```

The cron wrapper remains a thin heartbeat entrypoint. It alerts on failure and
never changes the chosen pane, model or effort.
The nightly compact idle check uses the existing bounded Dream history reader
when Codex compact records hide the last authored turn from the small tail.
It verifies an unchanged journal stamp and exact source path; exhausted,
unreadable or changing history stays unknown. Regular polling does not acquire
this larger cold-path scan, and the 80k/idle/once-per-night rules do not change.
The guarded ten-minute missed-night trigger and durable attempt semantics are
documented in [Dream policy](DREAM-POLICY.md#missed-schedule-after-downtime).

`amux memory status`, `memory lint` and `doctor` inspect the existing local
daily `dream-cron.sh` schedule. The deadline is the cron time plus one hour;
`AMUX_DREAM_GRACE_MS` explicitly adjusts grace (1 minute to 6 hours).
System timezone or `CRON_TZ` controls scheduling, while Dream's memory filenames
remain Stockholm dates. A plain cron `TZ` environment variable does not change
the scheduler timezone. Unsupported or unavailable schedules report WARN rather
than inventing a deadline. An unconfigured Dream is reported as disabled.

After the deadline, missing/stale results warn even without a failure marker.
Success requires the current daily sentinel plus the existing run/source/owner
validated artifact matching the committed summary; a controller's zero-work
run is also valid. An older failure does not override a later validated success.
These checks are offline/read-only: they never prompt a pane or rerun Dream.

New runs store the exact verified result in `memory/dream/DATE-RUN.md`, linked
from the daily Dream block. The snapshot is published without replacement,
read-only, with its hash, run and source identity in the daily reference.
Later notes and corrections belong in the editable daily file outside that
block. They do not invalidate the original result or pretend to have been part
of the night's source. Snapshot edits still fail verification. Existing inline
Dream blocks retain their original strict verification until explicitly migrated;
an edited legacy block must not be silently blessed or overwritten.

## Retrieval after startup or compaction

`amux memory context` is a read-only entry for every CLI harness. It exposes
today/yesterday paths and versions, not copied diary text. Read only the material
relevant to the actual request. Large/unreadable sources remain explicit;
the command does not claim that a digest or the reader's understanding is correct.
File availability and digest validation are reported separately. The digest
field reuses the existing controller-artifact verifier; a file or copied success
marker alone is not a validated run. Even a valid bounded digest is not proof
that every fact reached a long-term note.
Verified snapshot paths appear in this same bounded reference card. Normal
memory search includes the Markdown snapshots; they are not a second database.
New Dream prompts explicitly follow relevant daily Dream links and later
corrections. Old run recovery preserves the original prompt bytes.

When recovery establishes a material correction, the active agent saves it in
the existing topic note when authorized, with its event date and original source.
It then checks the saved result through normal retrieval. Dream supplements this
write-back; it is not the only chance to preserve an already verified correction.
The shared `context-recovery` skill owns that workflow. Read-only requests remain
read-only, and personal notes stay in the private workspace rather than this repo.

The existing Claude `SessionStart` hook emits the same bounded reference card.
On `UserPromptSubmit`, it emits again only when daily versions changed, keyed to
the exact pane and session. It neither wakes idle panes nor creates model turns.
An emitted pointer is not proof the model read the file.
See the [Claude hook output contract](https://code.claude.com/docs/en/hooks).

For tmux Codex and Kimi, the existing durable delivery broker attaches a short
pointer to `amux memory context` to the next real prompt. It does not enqueue an orientation turn.
The original ask/verification text stays unchanged; the complete physical payload
is persisted before paste and remains identical across retries. Receipt checks
compare the complete physical text, not just its original-message prefix. Phone
and Link response queries resolve that same stored payload within the exact
session; no substring match is used to loosen delivery proof. Only an actual
delivery receipt advances the orientation stamp. The stamp belongs to one pane
and exact session, not to a model/profile label. Refresh happens after memory or
observed compact-epoch changes, or after 30 minutes without an AMUX delivery.
The delivery pointer is at most 512 bytes; the CLI's reference card is at most
2 KiB. No diary contents are attached. Keeping the prompt itself smaller matters:
native Codex compaction can retain historical user messages rather than replacing
all of them with a summary. Detailed retrieval belongs in tool output, on demand.

Codex can create a `/new` rollout only when its first prompt arrives, after
orientation was prepared against the previous saved session. Response lookup may
bridge those identities only with an acknowledged exact physical prompt in the
current pane-owned rollout, after the stored append cursor and within the same-host
pre-paste/acknowledgement interval. Copied old events and changing identities do
not qualify. This does not resend anything or rewrite the original receipt.

Direct terminal typing in Codex/Kimi bypasses the AMUX broker: use the existing
`amux memory context` entry then. Native runtime next-turn injection is not wired
here. Neither limitation justifies starting or replacing those sessions.
Unknown identities skip automatic context; unreadable optional memory never
blocks the real message. This is an orientation aid, not proof of understanding.

An independently installed legacy startup hook that still reads complete daily
files must be changed at its own source to references-only. The AMUX installer
preserves unrelated hooks and cannot silently remove their private configuration.

## File policy

- `MEMORY.md`: short curated index, never automatically compacted.
- Today's and yesterday's daily files: never old-file compact candidates.
- `references/*` and `people/*`: warnings only, never automatic rewrites.
- Session JSONL housekeeping is separate and preserves every record; it only
  shortens oversized string fields in sufficiently old inactive journals.

## Safety properties

- Source packets are bounded and treated as untrusted data.
- Prompt visibility is acknowledged before delivery to the pane.
- Haiku, effort `low`, unknown runtime quality and missing compact receipts fail
  closed.
- The pane writes an isolated result, not the daily memory file.
- The controller validates size, line count, reserved markers and current run
  provenance before one atomic insert.
- Receipts advance only after the durable memory product exists.
