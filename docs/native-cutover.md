<!-- template: reference -->
> **Why:** One fail-closed command moves existing Claude/Codex panes from tmux to AMUX Code without changing conversation identity, and leaves a byte-exact rollback receipt.

# Native fleet cutover

`amux cutover` is dry-run by default. It imports only persisted engine session
IDs; import never starts an engine process, so tmux remains the sole writer
until the final preflight has passed.

```bash
amux cutover --all \
  --runtime http://127.0.0.1:8813 \
  --manage-services \
  --drop-shells \
  --allow-empty
```

The dry run must report `DRY RUN GREEN`. It checks, twice, that every coding
pane is idle in both the live pane state and engine JSONL, that the durable
delivery lane has no non-terminal message, and that exactly one persisted
Claude/Codex session belongs to the pane cwd. Missing, duplicated or busy
identity is a blocker by default. `--allow-empty` is the narrow exception: it
allows a fresh native session only when both the session identity and all
persisted turn history are absent.

Run the same command with `--apply` for the switch:

```bash
amux cutover --all \
  --runtime http://127.0.0.1:8813 \
  --manage-services \
  --drop-shells \
  --allow-empty \
  --apply
```

The apply path is ordered:

1. import every exact session idempotently without launching it, while
   recording any explicitly proven-empty pane for fresh creation after stop;
2. repeat the full idle/queue/identity proof and verify both config hashes;
3. stop each target tmux session;
4. move configured service commands to ownership-verified detached process
   groups (`amux services status` shows PID and log); interactive shell panes
   are discarded only because `--drop-shells` was explicit;
5. atomically materialize `backend: native` plus `nativeAgentIds`, reload the
   bridge, and adopt every imported runtime agent;
6. require every adopted runtime session ID to equal the preflight ID.

Any failure after tmux stops restores both config files byte-for-byte, reloads
the bridge, stops newly managed services, and recreates the old tmux sessions.
Every phase is written to a private receipt under
`~/.agentmux/native-cutovers/`.

The success message prints the exact rollback command:

```bash
amux cutover --rollback ~/.agentmux/native-cutovers/<receipt>.json
```

Rollback refuses while an imported native turn is running. It then stops only
ownership-proven native service process groups, restores the original config
bytes, reloads the bridge and starts the tmux groups. Runtime agents and native
engine history are preserved as evidence; they are not deleted.

## Service and shell policy

- `--manage-services` keeps `services:` in `agentmux.yaml`, but they are not
  fake browser agents and consume no Discord pane address. The native service
  manager launches one process group per command, records a private identity
  marker and refuses to signal a reused or mismatched PID.
- `--drop-services` is the explicit alternative when dev servers should stop.
- Native has no interactive shell-pane abstraction. A fleet containing
  `shells:` therefore blocks unless `--drop-shells` is explicit.
- `--manage-services` and `--drop-services` are mutually exclusive.

## Messages during work

AMUX Code accepts later browser, CLI and Discord prompts while a turn is
running. They are persisted in a bounded per-agent FIFO before acceptance and
shown as `Queued` in the delivery journal. The composer remains available and
shows the queue count. Each prompt gets its own idempotency receipt and starts
only after the preceding turn is terminal.

If the native runtime itself restarts after a prompt was submitted but before
its outcome was recorded, that receipt fails loudly as an uncertain delivery;
it is never replayed automatically into a possibly already-mutated workspace.
