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

The Windows manager (`bin/windows-manager.mjs`) is the only listener on the rescue channel. The
PowerShell restarter that first owned these commands last polled on 2026-08-01; while the manager
still skipped `//` text as "restarter-owned", three `//restart-wsl` orders got no reply and no
restart (2026-09-12 to 2026-09-14). The manager's local parser now runs every command below
without the model, and answers an unknown `//command` with the list instead of staying silent.

- `//status` — Windows/WSL/bridge/release/memory status with boot identity.
- `//logs` — bounded, redacted tails from Windows.
- `//start-wsl` — one bounded WSL start, only when WSL is proven offline; never shuts WSL down.
- `//start-bridge` — starts the WSL bridge only when absent.
- `//restart` — legacy alias for `//start-bridge`; never shuts WSL down.
- `//recover` — status → start missing WSL → start missing bridge → verify.
- `//restart-wsl` (or `//hardrestart`) — the authorized human's explicit order is the fence: the
  manager posts `AMUX startar om WSL nu` with the current boot before exactly one shutdown/start,
  then reads status again and answers `WSL är omstartat: boot A -> B` or
  `WSL startades INTE om: samma boot A`. A trailing `--receipt ID` is accepted and not checked.

Every order runs at most once. A Discord message is consumed in the same state write that accepts
it, before any tool runs, so a reply that fails to send is kept in `pendingReplies` and retried
as a message on the next polls (up to 12 attempts) while new orders wait behind it. It is never
re-executed. Tools that change Windows or WSL (`start_bridge`, `start_wsl`, `recover`,
`restart_wsl`) are also recorded per order in `managerOrders` before they run, so a redelivered
phone or Link message is refused with `refused:already-executed`.

Once a minute the manager checks `wsl.exe --list --running` and reads the boot ID only from a
distro that is already running, so the watch never starts a WSL someone shut down. A boot change
the manager did not order (a manual `wsl --shutdown`, a Windows reboot, a crash) posts
`WSL har startat om (inte via //restart-wsl): boot A -> B.` once. The last boot is persisted, so
a manager restart neither repeats nor misses it. A turn that already reported its own restart
stays silent; if WSL came back only after that answer, the watch posts
`WSL är uppe igen efter //restart-wsl: boot A -> B.`

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
