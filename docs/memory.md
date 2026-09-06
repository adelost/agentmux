# amux memory

## Current design (2026-08-01)

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
  -> controller-owned atomic daily block
  -> read-only memory lint
  -> incremental search reindex
```

The cron wrapper remains a thin heartbeat entrypoint. It alerts on failure and
never changes the chosen pane, model or effort.

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

## Retrieval after startup or compaction

`amux memory context` is a read-only entry for every CLI harness. It exposes
today/yesterday paths and versions, not copied diary text. Read only the material
relevant to the actual request. Large/unreadable sources remain explicit;
the command does not claim that a digest or the reader's understanding is correct.

The existing Claude `SessionStart` hook emits the same bounded reference card.
On `UserPromptSubmit`, it emits again only when daily versions changed, keyed to
the exact pane and session. It neither wakes idle panes nor creates model turns.
An emitted pointer is not proof the model read the file. Other harnesses can use
the CLI; automatic next-turn hooks for them are not implemented by this change.
See the [Claude hook output contract](https://code.claude.com/docs/en/hooks).

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
