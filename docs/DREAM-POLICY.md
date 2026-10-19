# Dream activity policy

`amux dream` uses one explicitly configured, existing AMUX pane. It never
starts a hidden model process and never chooses a model, effort level, or
provider on the operator's behalf.

## Configuration

The source of truth is `~/.agentmux/agentmux.yaml`:

```yaml
dream:
  agent: sandman
  pane: 0
  candidates: [sandman:1]   # Claude primary, Codex fallback, separate dedicated panes
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

Reserve these panes for Dream rather than product work. `dream` is a reserved
runtime configuration key, so use an agent name such as `sandman` and label
its panes Dream. New panes use their existing default account profile 1;
creating them does not rotate any existing pane or log in another account.
Startup, quality and compact failures can try the next configured candidate.
Fallback is preparation-only. After one dispatched curation, a limit, missing
answer or invalid product ends that attempt honestly; it never purchases a
second curator turn that night. Recovery reuses the original output and proof.
Only the selected, exactly receipted product can enter memory.

## Exact algorithm

1. Read the [canonical conversation log](CONVERSATION-LOG.md) first. The raw
   journal path below remains the explicit `AMUX_DREAM_SOURCE=raw` retreat
   and the fallback for panes without posted work or complete pre-log windows.
   In that path, read configured Claude, Codex and Kimi journals to each pane's window
   start: its successful Dream receipt, or 24 hours before the scheduled
   invocation when it has none. A receipt older than seven days before that
   point starts the window at seven days, so a failed night's work reaches the
   next digest instead of falling behind a fixed 24-hour window. Dream prompts,
   compact commands and system plumbing are excluded.
   Tails start at 512 KiB and double until they reach the window start, not
   until any work is visible: on 2026-09-16 one 0.52 MiB tool output hid 20 of
   skyvw:5's 21 turns. Claude reads up to 64 MiB in each of at most six rotated
   sessions. Codex grows to 8 MiB, then reuses the search JSONL stream over a
   64 MiB output window, retaining at most 8 MiB of authored/lifecycle events.
   When that window begins mid-turn, a single streaming prefix scan recovers
   only the last still-open canonical user input and its same-task context.
   Original input stays exact; closed/different tasks, setup and quoted output
   cannot provide it. The 4 MiB record and 8 MiB retained limits still fail
   loudly, including for an oversized origin. Prefix IO can exceed 64 MiB;
   it does not allocate the journal or enter older output into model context.
   A recovered active turn remains explicitly deferred with no cursor advance,
   rather than failing the night or claiming its work is finished.
   A shared bounded writer-prefix classifier identifies the top-level
   and first payload type, never quoted types inside text. Oversized records
   unused by the reader are skipped, including future image/tool result types.
   Oversized human/assistant messages, lifecycle/context and tool calls remain
   explicit gaps rather than silently disappearing. An unclassifiable prefix
   also fails closed. An oversized required/unclassified record fails the pane only when the tail
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
   completion receipt. Codex may write model context before the user prompt;
   accept it only with matching native task-start, context and completion turn
   IDs. An earlier unrelated context never proves this task's model. Audit
   tool invocations from the exact original native
   prompt through its terminal reply, not later independent turns or read
   results. Refuse curator memory writes, including writes later restored.
   Preserve current notes outside the Dream block, including inserts and
   corrections in the middle of the file. The exact protected block must
   remain unchanged; malformed, duplicated or changed markers refuse commit.
   New packets pin the block baseline and actual read time alongside the
   original whole-file hash. Other panes' legitimate edits are not hash conflicts.
9. The controller publishes the validated result without replacement as a
   read-only `memory/dream/DATE-RUN.md` snapshot, then atomically inserts its
   hash-bound link into the one marked daily Dream block. Only then are pane
   cursors advanced and the run sentinel added. Later manual notes belong
   outside that block; the verified product is never a live status scratchpad.

## Memory-warning repairs in the same curator turn

The controller reads actual `amux memory lint` findings into
`payload.memoryRepair`, with stable finding ids and exact writable-file hashes.
At most24 findings/4KiB enter this packet; remaining counts are explicit and
point to lint, never silently discarded. These bytes share the96KiB input
budget. Warnings alone can justify the one ordinary curator turn; clean lint
and no new work leave the curator untouched.

The model still writes only its isolated result, not memory or controller
receipts. It may finish the same result with an optional footer:

````text
```amux-memory-repairs
{"version":1,"repairs":[{"warningId":"id from input","before":"unique exact text","after":"candidate text"}]}
```
````

Only warning-targeted existing `MEMORY.md`, `memory/people.md` and immediate
people/reference Markdown files are eligible. Daily files, Dream snapshots,
archives, journals, templates, policy and symlink targets are not. Initial
automatic edits are conservative metadata additions and exact in-place
rebindings of a reported broken link to an existing file. Every non-metadata
line and its order must remain unchanged. Factual rewrites, cross-file moves
and missing semantic facts are questions, not automatic edits.

Before any write, the existing linter evaluates the candidate through a text
overlay. The target warning must disappear with no new warnings. Exact hashes
are checked again before atomic replacement; lint runs after it too. A failed
post-write check restores only the controller's own unchanged candidate;
unexpected concurrent content refuses rollback rather than destroying it.
No hidden rewrite of daily history is part of this path.

The controller preserves the raw model product as `.curator.md`, its repair
plan/outcomes as `.memory-repair.json`, and normalizes the final `.summary.md`
to human text. Both artifacts remain beside the original Dream input. The
normalized hash makes crash recovery idempotent without another model turn.
Curator writes to these controller artifacts are refused by the existing
tool-write audit. The human product, including unresolved questions, remains
subject to the ordinary60-line/12KiB snapshot limit; the curator uses30lines/
4KiB to reserve space. A missing lesson, such as Isabella's, becomes an
explicit question to Mattias. Known archive/bank findings retain their existing
maintenance actor instead of asking him to manage those jobs.

`amux dream --dry` prints the actual warning count and eligibility, but writes
neither candidate files, repair artifacts, receipts nor summaries. Original
products without the footer remain valid. A warning-only product still gets
its normal verified snapshot; zero fleet panes is never fabricated activity.

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
separately. A saved digest never clears an unresolved compact pass. A new
ordinary controller run can repair the day: only after its verified product
and sentinel does it bind that run/source to the existing nightly-compact
report. Health accepts a later zero-unresolved pass for that exact product
while preserving the original failed schedule receipt unchanged. Recovering
an old summary alone never creates this maintenance proof.
The newest matching maintenance report controls health; an earlier failed
observation does not override a later verified pass. Digest validation remains
independent, so uncertain maintenance never makes a valid summary unrecoverable.
Unverified/unmeasured rows can reconcile through the shared exact-session,
no-new-work native compact proof. The normal pass checks that proof before
reporting; `reconcileNightlyCompactReport` can also store a linked copy of a
recorded pass without starting any new compacts or surveying later fleet work.
Original reports and outcomes remain intact. Failed or measured-above-budget
rows are not converted into successes.

## Finish an interrupted controller without another model turn

If the original pane completed its isolated result but the controller stopped
before committing it, inspect that exact run with:

```text
amux dream --recover /absolute/path/DATE-RUN.json --source-sha256 SHA --dry
```

Removing `--dry` finishes through the normal compare-before-write, atomic block
and receipt path. It never starts a pane, compacts, sends a prompt, runs nightly
maintenance or buys another model turn. It requires the original input hash,
same configured original owner/session/model/effort, valid isolated output and
the original exact native terminal reply. Today's busy state and later work
are not evidence against that already completed task. The protected block
baseline and curator-write audit apply just as in normal commit, unless a
durable controller commit intent already proves completion.
A newer activity receipt blocks recovery; a validated same-run result
is already complete and is not written again.

New input packets pin the original workspace and pre-run daily-memory SHA.
Older packets require `--workspace PATH --memory-sha256 PRE_RUN_SHA`. That hash
must come from evidence captured before curation, never from hashing whatever
the memory file contains now. Existing format-two packets without a stored
block baseline can recover only into an absent Dream block after the original
native task and curator-write audit succeed. They cannot replace an existing
block. Older format-one packets keep their whole-file hash fence. Missing
original evidence means stop. Recovery never fabricates a preimage hash or
queue acknowledgement and never reruns nightly maintenance. Original unreadable
sources and maintenance failures remain separate from a recovered digest.

## Other memory maintenance

Nightly `amux memory lint` remains read-only. A verified night first archives
the day it covered, with the night's summary in that day's stub. Before lint,
`amux memory archive --apply` moves other finished oversized daily files
byte-for-byte to `memory/archive/daily/` and leaves a stub; after it, `amux
memory bank` commits `memory/` locally (secret scan first, never push). Neither
uses a model. See [memory](memory.md).
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
