<!-- template: reference -->
> **Why:** Safe, exact-session rollback between the native AMUX Code runtime and the existing tmux transport without creating a second conversation.

# Native runtime rollback

This procedure applies to one isolated canary target at a time. Fleet migration
uses the separately gated [`amux cutover` contract](native-cutover.md), which
automates exact-session import, receipts and rollback. Discord and the tmux
bridge remain available as the fallback until the native replacement gate is
green and a migration is explicitly applied.

## Preconditions

1. The target has no active turn and its delivery queue has no `submitting`, `submitted`, or `delivered_unverified` head.
2. Save each pane's engine, native `sessionId`, model, effort, project directory, and last accepted operation key from `/api/agents/:id/history`.
3. Run `amux runtime status` without a port and verify every managed runtime row, including port, boot, agent count and data directory. Use `--port N` only to inspect one known runtime. Never signal an unmanaged process.
4. Keep the original native config and registry directory unchanged; make a dated backup of `agents.yaml` before editing it.

## Native to tmux

1. Stop only the idle native runtime with `amux runtime stop`. Do not use `--force` for a routine flip.
2. Change only the canary target from `backend: native` to its normal tmux pane definitions.
3. Put the exact persisted ID on every coding pane:

   ```yaml
   panes:
     - name: claude
       cmd: claude
       resumeSessionId: 11111111-1111-4111-8111-111111111111
     - name: codex
       cmd: codex
       resumeSessionId: 22222222-2222-4222-8222-222222222222
   ```

4. Start/reconcile the isolated target normally. Claude launches with `--resume <id>` and Codex with `codex resume <id>`. An explicit ID is fail-closed: Codex has no `--last || fresh` fallback, and malformed IDs are rejected before shell construction.
5. Send one harmless continuity marker per pane. Confirm the engine-reported session/thread ID is exactly the saved ID before doing real work.

If any ID differs or resume fails, stop the canary tmux session and restore the native config. Never answer a resume failure by starting a fresh session under the same pane address.

## Tmux back to native

1. Wait until both tmux panes are idle, then stop only the isolated canary tmux session.
2. Restore the exact native config and start the same runtime data directory.
3. Confirm every restored agent has the original agent ID and engine session ID.
4. Replay the saved operation key through the compatibility adapter. The response must say `replayed: true`, history must contain no additional completed turn for that key, and the session ID must remain unchanged.
5. Run the native canary gate. It performs the same native→tmux→native sequence in isolated data, workspace, event-ledger, queue, port, and tmux socket namespaces.

## Abort conditions

- active turn or ambiguous delivery fence;
- unmanaged/stale runtime PID;
- missing or malformed session ID;
- resume opens another session;
- old operation key is accepted as a new turn;
- any default/live tmux session or production runtime would be touched.

The rollback is complete only after both session continuity and idempotent replay are proven. Historical JSONL and registry receipts are evidence and must not be deleted.
