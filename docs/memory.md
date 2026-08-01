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
