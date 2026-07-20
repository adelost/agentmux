# Windows rescue bridge

The Windows rescue bridge is a small Discord control plane that remains reachable when WSL,
tmux, or the WSL AMUX bridge is offline. It owns one dedicated Discord channel and never shares
that channel with the WSL bridge.

## Safety boundary

- The visible Windows PowerShell window is the canonical runtime. Hidden supervision is opt-in.
- Every `wsl.exe` call has a hard timeout. A timeout reports unknown state; it does not authorize a
  retry, kill, or shutdown.
- `//recover` starts only a component proven missing. A live process with a stale heartbeat is
  `BLOCKED bridge-hung`, not a restart opportunity.
- `//restart-wsl` requires a fresh `amux restart-ready` receipt. The receipt is bound to the WSL
  boot ID, installed source SHA, configured fleet, and live tmux session identities.
- Restart readiness fails closed on incomplete or unclassified coding-agent turns, unfinished
  deliveries, dirty or rebasing worktrees, or invalid release identity.
- Windows copies the verified receipt before exactly one shutdown. A crash during the action
  leaves a durable `crashed-mid-action` fence and never replays the Discord message.
- Tokens are DPAPI-encrypted for the current Windows user. Commands and logs never render secrets.

## Install

Create a dedicated Discord text channel first. Do not add it to `agentmux.yaml` or generated
`agents.yaml`.

```bash
amux restarter install --channel DISCORD_CHANNEL_ID --user DISCORD_USER_ID
```

Installation refuses a channel already mapped to a WSL agent. It stages an immutable Node decision
core, verifies its source SHA and file hashes, registers a visible logon process, and opens the
visible listener window. Optional hidden supervision is explicit:

```bash
amux restarter start-supervised
```

## Discord commands

- `//status` — Windows/WSL/bridge/release/memory status with boot identity.
- `//logs` — bounded, redacted tails from Windows and WSL.
- `//start-wsl` — one bounded WSL start; never shuts WSL down.
- `//start-bridge` — starts the WSL bridge only when absent, in a visible Windows terminal.
- `//recover` — status → start missing WSL → start missing bridge → verify.
- `//restart` — explicit legacy bridge-only rescue; never shuts WSL down.
- `//restart-wsl --receipt ID` — exactly one fenced shutdown/start from a fresh receipt.

Create the receipt immediately before a planned restart:

```bash
amux restart-ready
```

If it reports blockers, finish or checkpoint those exact panels, drain deliveries, and clean the
listed worktrees. Do not manufacture a receipt or bypass the inventory.

## Cheap verification

The PR gate runs only changed-file strict lint, mapped focused unit/component tests, and the CI
contract check. It never invokes the full test suite. Before release, parse all three PowerShell
files with Windows PowerShell and rehearse `//status`, `//logs`, `//recover`, and the missing/stale
receipt refusal. A real WSL shutdown is a separate explicit operator action.
