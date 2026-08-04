# Dream activity policy

`amux dream` uses one explicitly configured, existing AMUX pane. It never
starts a hidden model process and never chooses a model, effort level, or
provider on the operator's behalf.

## Configuration

The source of truth is `~/.agentmux/agentmux.yaml`:

```yaml
dream:
  agent: claw
  pane: 3
  candidates: [claw:3, claw:1]   # optional, ordered, tried in turn
```

`amux sync` validates that the address exists and denotes a tmux Claude or
Codex pane, then carries it into generated `agents.yaml`. There is no default.
Kimi and native panes are rejected until they can produce the same exact
compact receipt.

`candidates` is optional; without it the single configured pane is the only
curator, exactly as before. With it, Dream tries each entry in order and
curates from the first one that is live and idle. Every candidate is still
written in `agentmux.yaml`, so the curator remains visible and operator-chosen
and no hidden model process can be selected. Entries accept `agent:pane` or
`{agent, pane}`; a candidate that does not resolve is an error rather than a
silent omission, because a quietly dropped entry would remove the resilience
the list exists to provide.

## Exact algorithm

1. Read bounded journal tails from configured Claude, Codex and Kimi panes.
   Only turns newer than each pane's successful Dream receipt are eligible.
   Dream prompts, compact commands and system plumbing are excluded.
2. Keep at most eight turns and 5 KiB per pane, at most 48 panes, and at most
   96 KiB total input. Every omission and unreadable journal remains explicit.
3. Require the owner pane to be idle. The first candidate keeps the full grace
   period, since a pane that is merely mid-turn is still the preferred curator;
   any further candidate only has to be idle right now, so one stuck pane cannot
   spend the whole window. A skipped primary is logged and pushed to the human.
   Read the selected pane's actual model and effort from its own session
   journal. Unknown values, Haiku and effort `low` fail closed.
4. Send `/compact` to that exact session and require a new engine-native compact
   boundary plus the same session ID afterward. A delivered slash command by
   itself is not a receipt.
5. Bank the bounded input as a read-only local JSON packet with SHA-256 and a
   unique run ID.
6. Post the complete instruction synchronously to the pane's bound Discord
   channel. Only after Discord acknowledges it is the same instruction sent to
   the pane. The ordinary best-effort mirror is disabled for this send so the
   prompt appears exactly once.
7. The pane may read today's and yesterday's memory, but writes only an isolated
   per-run summary file. The prompt treats journal text as untrusted data and
   forbids delegation or model changes.
8. Require all three receipts: bounded valid output, exact `DREAM_OK` response
   for this run, and idle completion. Also prove today's memory remained
   byte-identical while the pane worked.
9. The controller atomically inserts the validated summary into the one marked
   Dream block. Only then are pane cursors advanced and the run sentinel added.

Any failure leaves Dream receipts unchanged. `amux dream --dry` performs source
collection and prints the exact visible prompt template, but does not compact,
send, call a model, or write memory.

When no candidate is idle the run still hard-fails, and the failure is recorded
where it will be seen: the controller writes an `amux-dream-failed` marker plus
a visible `DIGEST SAKNAS` line into the day's memory file, and `amux memory
lint` turns that marker into a `dream_gap` warning when the same day has no run
sentinel. A lost night used to be visible only as a MISSING sentinel, and nobody
greps for an absence, so the file read exactly like an ordinary quiet day.

## Other memory maintenance

Nightly `amux memory lint` remains read-only and reports the old-file backlog.
Automatic `amux memory compact` is retired: it previously used a hidden
one-shot model process. The command now supports `--dry` for inspection and
fails closed before touching git or memory if asked to rewrite files.

## Rejected alternatives

- A hidden one-shot model is cheap but hides the model, effort, prompt and
  judgment from the operator.
- Waking every pane spends context in every runtime and multiplies failure
  points.
- Letting the selected model edit the daily memory directly grants more write
  authority than necessary. Isolated output plus a controller-owned atomic
  insert is narrower and auditable.
- Treating command delivery as proof of compaction risks summarizing stale
  context. The engine journal boundary is the receipt.
- Silent truncation creates a false receipt. Omitted material stays explicit
  and is never receipted.
