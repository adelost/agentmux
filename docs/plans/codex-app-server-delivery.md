# Codex deliveries through app-server

Design, row 215, 16 November 2026. Owner lsrc:7. Requested by plan:2 on
lsrc:0's decision, delivery:70e242ad889020328c0e2ef6c27f035f at 16:26:22Z.
This document specifies the implementation; publishing it does not migrate
a pane. Design estimate: own 1 hour, target 18:29Z, not an operator deadline.

## 1. Outcome and evidence

A Codex pane receives an AMUX delivery through `turn/start`, accepts follow-up
input through `turn/steer`, and acknowledges successful completion through the
matching `turn/completed`. Its terminal view remains attached through
`codex --remote`. One canary precedes fleet rollout. Tmux paste remains an
explicit transport choice, never a retry after an uncertain protocol write.

Plan:2's isolated probe, 16:10 to 16:20Z, used CLI 0.164.0 and thread
`01a1e520-e353-7100-8564-334d575f8094`: start response 0.1 s, steer response
9.7 s, completion 28.1 s, status completed; both inputs and MANGO appeared
in the TUI. These are the original probe's measurements, not new fleet tests.
Its daemon moved from 0.163.0 to 0.169.0 under its independent updater.
The reported 26 embedded fleet processes describe that probe's observation.

Read again for this design: CLI `--version` (0.164.0), launch/profile/broker
owners below, the original probe client, and version-generated JSON schemas.
Help for `app-server daemon update --from-cli` says **Copy and pin this CLI
package**. No server start, update, provider turn or profile change was made
in this design phase. Actual persistence and updater behaviour remain canary
acceptance conditions, not claims of implemented behaviour.

## 2. Existing owners and the changes they need

References are against `41e7d733a6e6e8d0e80bb1e0e2a72a6079381f4f`.

| Owner | Change |
| --- | --- |
| `core/agent-launch-command.mjs:78-95` | Keep embedded construction for paste targets. Add remote construction without the current `-m`, `-c`, `--disable goals` or `--yolo` overrides. |
| `core/codex-profiles.mjs:134-164,228-244` | Keep account isolation, selected account and per-pane model precedence. Put account defaults in its existing config, not repeated CLI flags. |
| `core/codex-process-launch.mjs`, `core/codex-launch-policy.mjs` | Keep exact thread identity, compact-first model changes, goal suppression during maintenance and model verification. Attach the TUI only after protocol configuration is verified. |
| New `core/codex-app-server.mjs` | Own one persistent WebSocket connection per account endpoint, initialization, request correlation, reconnection and notifications. Reuse existing execution-policy constants. |
| New `core/codex-delivery.mjs` | Map a durable job to one protocol input and its turn, with the recovery rules in section 5. No second queue or transcript store. |
| `core/agent-router.mjs`, `index.mjs:167`, `cli/tmux.mjs:47` | Route opted-in Codex delivery operations to that adapter while retaining tmux view/lifecycle. Browser-native targets retain their current owner. |
| `core/delivery-broker.mjs:181-240,317-350` | Add a distinct Codex protocol path. Do not reuse HTTP-native retry assumptions or its interrupted-turn ACK. |
| `core/delivery-wake.mjs:149`, `core/delivery-drain.mjs:16-24` | Separate accepted inputs awaiting completion from unsent FIFO heads, as section 6 describes. |
| `core/delivery-queue.mjs`, `core/delivery-queue-update.mjs` | Persist protocol metadata in the existing atomic job record; retain immutable payload, job identity and legacy submit fences. |

`spikes/web-ui/runtime-control.mjs` already implements initialization and RPC
request correlation for a private stdio child. Reuse its wire contract, not
its spawn-per-operation lifetime. A shared server must outlive one delivery
and a disconnected TUI. Do not create a second browser runtime to obtain that.

## 3. Server version and update ownership

Use Codex's existing managed package pin, not the mutable production selection.
For each account, an installer selects an **explicit 0.164.0 CLI package** and
runs its verified package entry point with the target `CODEX_HOME`:

```sh
<verified-0.164.0-codex> app-server daemon update --from-cli --yes
<verified-0.164.0-codex> app-server daemon start
<verified-0.164.0-codex> app-server daemon version
```

These are future installer actions, not commands run by this design. `--yes`
is used only under the existing release authority and an idle account server.
Never run plain `daemon update`, `codex update`, bootstrap or an installer for
latest as part of delivery, TUI attachment or crash recovery. `daemon stop`
alone is not an updater-disable contract, as the original probe demonstrated.

Record exact CLI/package version, executable/resource digests, resolved pinned
release path, updater selection and server process start identity. Both TUI
and server use the verified release; refuse a version/hash mismatch before
writing input. A changed `current` symlink is not permission to follow it.
Retain the package wrapper and resources: the local npm wrapper supplies
`CODEX_MANAGED_PACKAGE_ROOT` for package ownership. A bare copied executable
is not a replacement for a complete pinned package.
Before canary, prove the managed pin survives at least 12 minutes, two of the
observed six-minute update windows, including a daemon stop/start. No package
selection or digest may change. An updater may remain alive only if the pin
prevents production selection; a live updater PID is not proof either way.
If this fails, the pin condition is BLOCKED. Do not substitute another updater
or change version as a workaround inside the rollout.

One daemon belongs to one account `CODEX_HOME`, including its existing auth
and session store. A shared server must never combine the two account homes.
Socket paths are discovered under that home, resolved and ownership-checked;
private directories 0700, owned Unix socket, no TCP/public listener. Do not
alter primary `~/.codex` merely because the original probe used it.

## 4. Configuration without embedded-mode flags

Account `config.toml` owns its default `model` and `model_reasoning_effort`.
Write only managed keys atomically, preserve operator text/settings and keep
the previous file for rollback. Do not rewrite one shared default on every
pane start: two panes on one account can deliberately choose different models.
The inspected account-2 config already has both keys (Terra, high); preserve
that default rather than changing models as a side effect of this migration.

The existing AMUX per-pane override/history/default precedence still selects
each thread's effective model. Apply it through `thread/start` or
`thread/resume` (`model`, `config.model_reasoning_effort`), together with the
actual pane cwd and developer instructions. Compare returned `model`,
`reasoningEffort`, cwd and sandbox/approval policy before attachment/input.
Persisted thread choices survive reconnect; do not reset them on every delivery.
An explicit model change still passes `launchCodexWithPolicy` and its exact
compact receipt first. `turn/steer` cannot change model or effort.

Remote view command, using the same verified package and account home:

```sh
CODEX_HOME=<account-home> <verified-codex> --remote unix://<owned-socket> resume <exact-thread-id>
```

No `-c`, `-m`, `--profile`, `--enable`, `--disable`, `--search`, `--yolo` or
embedded fallback in this launch. Set equivalent approved execution policy
through the existing autonomous thread policy. Transfer pane-specific
instructions through `developerInstructions`, not a global account setting.
Maintenance that currently uses `--disable goals` instead supplies the
equivalent `features.goals = false` thread config before resume; prove that no
saved goal starts a turn in that path. If 0.164.0 cannot suppress it through
the protocol, that
maintenance case stays on the explicit paste path and blocks fleet completion.

Use the exact saved thread/account mapping; never `resume --last`. A new
thread is created only by the existing authorized fresh-bootstrap path.
Closing the TUI must not interrupt, delete or archive the thread. A reconnect
attaches that same thread rather than starting a fresh task.

## 5. Input, receipt and recovery contract

Use WebSocket frames over the owned Unix socket, as the probe did. Raw JSON
written to `app-server proxy` is not the tested transport. Initialize once per
connection, send `initialized`, then subscribe/resume the exact thread.

Before any socket write, durably save the existing job's account, endpoint
generation, thread id, immutable payload digest, method, stable
`clientUserMessageId = delivery:<job-id>` and submit fence. RPC request ids
only correlate responses; they do not promise idempotent execution.

| Observation | Job outcome and next action |
| --- | --- |
| Failed before any write, including wrong version/identity | Pending/refused with reason. Safe to retry connection; no input submitted. |
| Exact idle thread | `turn/start` with text input and stable client id. Save returned turn id. |
| Exact active thread, ordinary follow-up | `turn/steer` with that `expectedTurnId`, text and stable client id. Save its returned turn id. |
| Explicit stale-turn rejection | Re-read active state under the writer lease. A new start is allowed only after proving that this request was rejected without accepting input. |
| Matching user item | Record received time only when thread, `item.clientId`, exact content/digest and turn match the fenced job. Preserve item id. |
| Matching `turn/completed`, status completed, and input receipt | Final ACK once; save turn status, completion time and receipt source. |
| Failed/interrupted terminal turn | Record actual failure/interruption, not a successful completion. No automatic rerun or paste. |
| Timeout, disconnect or crash after write | Submitted/uncertain. Reconnect and reconcile history. Never resend, press Enter, restart the thread or switch to paste on this evidence. |

The 0.164.0 schema includes `clientUserMessageId` on both input methods and
`clientId` on persisted user items. It does **not** document server deduplication
for repeat requests. Correlation is not a promise of exactly-once effects.
The implementation must prove client-id echo/persistence in canary; otherwise
ambiguous writes remain unverified and rollout stops.

On reconnect, resume/subscribe before reading metadata and paginated
`thread/turns/list` plus `thread/items/list`; reconcile overlapping events by
thread/turn/item identity. Bound the read to fenced jobs and follow cursors,
not only the newest page. A persisted matching completed turn recovers a lost
notification. Matching text alone, another thread's completion or a quiet TUI
does not. Absence from one history page never proves that input was not sent.
Retain the existing 60-minute submitted bound for unresolved receipt checks;
expiry yields delivered_unverified, not a retry. Duplicate notifications are
no-ops after the durable receipt is committed.

## 6. Keep steering possible and retain admission rules

Today's drain serves the first nonterminal job. Holding a submitted job there
until its model turn ends would prevent the next input from steering it.
For protocol targets only, a job with an exact persisted input receipt becomes
nonblocking for dispatch while still awaiting completion. The same broker
continues checking completion for those jobs. No second queue/store is added.
Uncertain or unreceived writes remain blocking; unsent jobs keep FIFO order.
Several accepted inputs may map to one active turn, each with its own item
receipt and one terminal result. A completion must not ACK an unaccepted steer.

Keep the existing quota floor, builder cap, origin exemptions, wake/cost checks,
cancel check immediately before write, context maintenance and memory-context
preparation before input. The native fast path above the tmux wake gate is not
permission to bypass these. Release the writer lease after the bounded RPC
and durable state update; never hold it through the model turn. Retain the
current session-wide lease where tmux/maintenance still touches shared layout.

Slash commands remain commands, not text sent to the model. Route only mapped,
verified protocol operations (for example compact/interrupt) on opted-in panes.
Unmapped commands are visibly refused on that transport until an explicit
safe switch; never paste `/compact` into an uncertain protocol delivery.
Attachments use the existing intake/backup lifecycle and schema-supported
input items. A text-only canary cannot close fleet attachment support.

## 7. Transport selection and rollback

Add an explicit per-pane Codex delivery setting, default paste, selected in
the existing runtime config. Keep `backend: tmux` for the inspectable view;
this is not the existing `backend: native` browser runtime. Save transport on
each job at its first fence. Config changes never reroute an unresolved job.
Expose transport, account, thread, received/finished/uncertain and version in
existing inspect/doctor and queue output. A start response is shown as
accepted, not completed.

Rollback holds new input, reconciles all fences, detaches the remote TUI and
resumes the exact thread through the old embedded command only when its server
turn is idle and no uncertain input remains. Switch the pane's setting to
paste, retain receipts/history and prior config/package. Do not stop a shared
daemon to roll back one pane. If uncertainty remains, leave it held with the
reason instead of attempting the same action through two transports.

## 8. Slices and acceptance

1. **Pinned runtime and launch.** Add account pin/identity checks and remote
   command construction behind opt-in. No automatic fleet transition. Prove
   version equality, 12-minute pin stability, model/effort/cwd/instructions,
   execution policy and maintenance goal suppression on an isolated account.
2. **One-pane delivery.** Add adapter and broker receipt handling. Use an owned
   scratch thread with no product actions. Start, steer, complete and inspect
   both inputs in its remote TUI. Kill/reconnect only the client at write and
   completion boundaries; the same input runs at most once, or stays visibly
   uncertain without replay. Close/reopen the view without stopping the turn.
3. **Fleet rollout.** Migrate one idle owner-selected pane, then other idle
   panes individually after their canary passes. Never restart all 26 at once
   or migrate an active/uncertain thread. Prove different models on two panes
   sharing an account, account separation, attachments, compact/model change,
   quota holds/human exemption and explicit rollback through the normal bridge.

Extend existing `core/agent-launch-command.test.mjs`,
`core/codex-profiles.test.mjs`, `core/agent-router.test.mjs`,
`core/delivery-broker.test.mjs`, `core/delivery-queue.test.mjs` and
`core/codex-model-command.test.mjs` only where the slice touches their contract.
Required risk cases: lost start response, wrong-thread completion, duplicate
event, accepted steer sharing a turn, stale steer rejection, restart during
fence, no client-id echo, version drift, no cross-pane config overwrite and
no fallback after uncertain write. No new test files or whole-suite run.
Strict changed-file lint and the repository's targeted gate precede publication.

Design verification uses local schema/source/help only, AI USD 0.00. Future
canary turns consume subscription quota and require the existing admission;
this design grants no paid-credit spend. Measured times, IDs, versions and
remaining failures belong in the implementation row's evidence.

## 9. Sources and limits

- Original working client: plan:2's `codex-probe-client.mjs` in its
  `e5a0f19a-4b9e-4708-a131-30f435bf56e9/scratchpad` directory; original
  delivery above preserves its full path and measured run.
- Local schema/help evidence and digests:
  `/home/adelost/lsrc/.artifacts/codex-delivery-215-lsrc7-20261116/local-evidence.json`.
- [Official OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server)
  supports remote TUI, handshake and turn lifecycle. Local versioned schema
  wins where current examples differ from 0.164.0.
- `bin/agent-cli.mjs` and `cli/commands.mjs:3113` confirm the separate
  project-name collision with `plan`. Use a freshly resolved `:N` target for
  this handoff, verifying its name immediately before sending. Do not hardcode
  the probe's `:6`. Fixing command/project dispatch is separate from this design.

Implementation and canary remain future work. No running fleet configuration
has changed as a result of this document.
