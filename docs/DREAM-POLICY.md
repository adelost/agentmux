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

1. Read configured Claude, Codex and Kimi journals back to each pane's window
   start: its successful Dream receipt, or 24 hours before the scheduled
   invocation when it has none. A receipt older than seven days before that
   point starts the window at seven days, so a failed night's work reaches the
   next digest instead of falling behind a fixed 24-hour window. Dream prompts,
   compact commands and system plumbing are excluded.
   Tails start at 512 KiB and double until they reach the window start, not
   until any work is visible: on 2026-09-16 one 0.52 MiB tool output hid 20 of
   skyvw:5's 21 turns. Claude reads up to 64 MiB in each of at most six rotated
   sessions. Codex grows to 8 MiB, then reuses the search JSONL stream over at
   most 64 MiB of disk history, retaining at most 8 MiB of authored/lifecycle
   events. Known oversized compact/tool-output records are not conversation
   input. An oversized unclassified record fails the pane only when the tail
   holds no attributable work; otherwise the tail's turns are used and the
   unread earlier history is marked `historyComplete: false`, because a
   journal only grows and a failed pane would never be read again. No journal
   is changed.
2. Show at most 24 turns per pane, 640 B per turn within 5 to 16 KiB per pane,
   at most 48 panes, and at most 96 KiB total input. When a pane has more
   settled turns, prompts a person wrote come first, then turns whose final
   text opens with SUMMARY, DONE or BLOCKED, then the newest; the rest are
   counted as `omittedTurns`. The receipt still advances to the newest settled
   turn. Holding older turns back instead never catches up: on 2026-09-16
   skyvw:0 had 103 work turns in one day, 70 of them background-task
   notifications. A newest turn without a completion marker whose journal
   changed within ten minutes is still running, is counted as `deferredTurns`
   and waits for the next night. Every omission and unreadable journal remains
   explicit.
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
8. Require all three receipts: bounded valid output, exact final journal-text
   `DREAM_OK` for this run, and idle completion. Earlier working commentary is
   not part of the final reply; a later action or screen-only match is not a
   completion receipt. Also prove today's memory remained
   byte-identical while the pane worked.
9. The controller publishes the validated result without replacement as a
   read-only `memory/dream/DATE-RUN.md` snapshot, then atomically inserts its
   hash-bound link into the one marked daily Dream block. Only then are pane
   cursors advanced and the run sentinel added. Later manual notes belong
   outside that block; the verified product is never a live status scratchpad.

Failure before commit leaves Dream receipts unchanged. Partial-commit recovery
has the explicit boundary described below. `amux dream --dry` performs source
collection and prints the exact visible prompt template, but does not compact,
send, call a model, or write memory.

When no candidate is idle the run still hard-fails, and the failure is recorded
where it will be seen: the controller writes an `amux-dream-failed` marker plus
a visible `DIGEST SAKNAS` line into the day's memory file, and `amux memory
lint` turns that marker into a `dream_gap` warning when the same day has no run
sentinel. A lost night used to be visible only as a MISSING sentinel, and nobody
greps for an absence, so the file read exactly like an ordinary quiet day.

## Missed schedule after downtime

The existing daily `dream-cron.sh` remains the time authority. Install the
cheap recovery trigger from that same installed package with
`node bin/install-dream-catchup.mjs` (`--dry` previews). It preserves the old
crontab privately and adds `dream-catchup.sh` every ten minutes. Before the
scheduled time, after validated success, or after an attempted night it does
not call a model, reindex search, notify repeatedly, or start engines.

Both entrypoints use one workspace/date intent, claimed inside the same
kernel-backed controller lock as manual Dream. Source cursors and history are
read after acquiring that lock. A missed attempt measures its 24 hours from
the scheduled invocation, not from a late startup, and panes with a receipt
read from that receipt. Only the current scheduled day is written: a failed
night's work lands in the next digest, never in a rewrite of the old day.
All existing curator and idle/queue/quality/compact fences still apply.

The controller and delivery queue share the same `flock`-backed lease primitive.
Lease files retain their inode; process exit releases ownership without a stale
reaper unlinking another process's lock. A live legacy PID holder blocks takeover.
Linux/WSL needs the local `flock` utility; missing kernel-lock support fails closed.
When upgrading an old unlink-based queue consumer, drain/restart that consumer
before running the new one. Mixed old/new consumer protocols are not supported.

`~/.agentmux/dream-schedule/<workspace-hash>/YYYY-MM-DD.json` preserves the
attempt and its exit status. A saved digest with an unsuccessful 80k pass is
`maintenance-unresolved`, not a successful whole night. A crash leaves the
intent in place. No automatic quota retries or intent deletion are allowed.
Prepared input, partial result or a prior failure requires inspection of that
exact run. New runs persist a controller commit intent after exact terminal
proof, before daily memory changes. Recovery can finish block/cursor/sentinel
writes without contacting the curator again. The existing block and snapshot
must match exactly; later notes outside the block are preserved. Missing old
commit intents still require the original session proof and pre-write hash.
Health exposes digest validation and the scheduled maintenance outcome
separately. A saved digest never clears an unresolved compact pass.

## Finish an interrupted controller without another model turn

If the original pane completed its isolated result but the controller stopped
before committing it, inspect that exact run with:

```text
amux dream --recover /absolute/path/DATE-RUN.json --source-sha256 SHA --dry
```

Removing `--dry` finishes through the normal compare-before-write, atomic block
and receipt path. It never starts a pane, compacts, sends a prompt, runs nightly
maintenance or buys another model turn. It requires the original input hash,
same configured owner/session/model/effort, valid isolated output, exact final
journal reply to the original prompt, idle completion and unchanged daily
memory, unless a durable controller commit intent already proves completion.
A newer activity receipt blocks recovery; a validated same-run result
is already complete and is not written again.

New input packets pin the original workspace and pre-run daily-memory SHA.
Older packets require `--workspace PATH --memory-sha256 PRE_RUN_SHA`. That hash
must come from evidence captured before curation, never from hashing whatever
the memory file contains now. Missing original evidence or a changed daily
file means stop; do not rebase the proof onto newer notes or overwrite them.

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
- Silent truncation creates a false receipt. Omitted panes stay explicit and
  are never receipted; omitted turns inside an included pane are counted in
  the input so the curator can say what it did not see.
