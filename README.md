# agentmux

agentmux is local developer tooling for coordinating Claude Code and Codex
agents across tmux panes. It adds a Discord-based ChatOps interface, a terminal
CLI, session isolation, structured logs, media handling, and operational
safeguards for long-running AI-assisted development workflows.

```text
Discord / amux CLI
        -> agentmux bridge
        -> tmux panes
        -> Claude Code / Codex
        -> structured logs, status, files, and replies
```

agentmux runs on your machine. It does not host agents for you; it connects
your local projects, tmux sessions, and coding-agent CLIs into one controllable
workspace.

## Why agentmux

- Run multiple Claude Code and Codex sessions side by side.
- Keep pane histories isolated so resume/continue does not cross wires.
- Delegate work between agents through the `amux` CLI.
- Inspect status, logs, timelines, and recent completed work from one place.
- Send and receive files, screenshots, PDFs, voice messages, and TTS replies.
- Recover stuck sessions with explicit operational commands.
- Protect long-running sessions with loop detection, reminders, and
  auto-compact support.

## Core Concepts

| Concept | Purpose |
|---|---|
| Agent | A named project workspace from `agentmux.yaml` |
| Pane | One Claude Code or Codex session inside a tmux window |
| Bridge | The Node.js process that connects Discord, tmux, and logs |
| `amux` | CLI for sending prompts, reading logs, checking status, and coordinating panes |
| `.agents/` | Generated per-pane working directories and instruction files |

Pane 0 runs in the project root. Pane 1 and above run in `.agents/N/`, giving
each coding agent its own session history while still letting Claude Code and
Codex discover generated project instructions.

## Features

### Multi-agent orchestration

- Route different Discord channels to different projects and panes.
- Run several Claude Code and Codex sessions per project.
- Delegate tasks from one agent to another with `amux <agent> -p <pane> "..."`.
- Fan out tests, audits, screenshots, or implementation work in parallel.

### Reliable session management

- Structured jsonl history for Claude and Codex output extraction.
- Durable prompt delivery with physical-submit and JSONL receipt verification.
- Resume hints for panes that restart without prior context.
- Model-aware context tracking.
- Recovery commands for stuck panes and blocking prompts.

### Durable prompt delivery

Discord, the `amux` CLI, media handoffs, and internal agent messages all enter
one persistent queue before agentmux touches tmux. Delivery is FIFO per pane
and single-writer per tmux session, including across bridge processes. The
queue also keeps private copies of temporary image and file attachments so a
bridge restart cannot turn a valid media prompt into a missing path.
Long and multiline prompts use terminal bracketed-paste mode, so the TUI
receives one input transaction rather than a slow stream of painted cells.

A prompt advances through `pending -> drafted -> submitted`, then ends as
`acknowledged` or `delivered_unverified`:

- `drafted` means agentmux owns exact text still associated with the composer.
  It blocks later writes so payloads cannot merge.
- `submitted` means the exact draft left the verified composer after Enter.
  Large atomic pastes require two independent empty observations (or fresh
  JSONL proof), so one torn Codex repaint cannot release the FIFO prematurely.
  The pane's write slot is released immediately, so the next prompt can be
  injected even while the agent is busy and the earlier JSONL receipt is late.
- `acknowledged` means the authoritative Claude/Codex history contains the
  exact prompt. Receipt reconciliation runs independently of later writes.
- `delivered_unverified` is a terminal at-most-once fence used only when a
  submitted prompt has lacked an exact history receipt for 60 minutes. AMUX
  never re-pastes it, removes it from active queue health, preserves it for
  audit/retention, and warns the bound Discord channel. That warning has its
  own durable retry state: a Discord outage cannot reopen the prompt, while a
  bridge restart retries the warning until it is accepted. Internal producers
  resolve the current channel from `agent:pane`; an unbound pane remains
  explicitly unsent in the audit instead of being marked as warned.

Foreign human drafts, hidden composers, and ambiguous submit results fail
closed instead of being overwritten or blindly re-pasted. Durable state and
bounded dialect-aware recovery let a restarted bridge resume without losing a
prompt or creating an unbounded duplicate loop. Rescue Enter and destructive
composer cleanup require two consistent live observations, while a fresh exact
JSONL event always wins over tmux repaint. `amux doctor` reports queue health
alongside bridge and tmux health.

### Hook-pushed pane state (event ledger)

Panes report their own state transitions through Claude Code hooks instead
of amux guessing from terminal scraping. `bin/install-hooks.mjs` registers
a lightweight hook (Stop / Notification / UserPromptSubmit / SessionStart)
that appends one JSON line per turn boundary to `~/.agentmux/events.jsonl`.
Status readers (`ps`, `done`, `wait`, auto-compact) merge these pushed
events with scraping via an allowlist: a pushed event may only refine a
scraped `idle`/`unknown`, never contradict a live observation (modals,
working). Scraping remains the fallback, so nothing breaks if hooks are
missing.

```bash
node bin/install-hooks.mjs        # install (idempotent, backs up settings)
node bin/install-hooks.mjs --dry  # preview
node bin/install-hooks.mjs --remove
```

Permission asks and session starts also surface in `amux timeline` as
🔔 event rows.

### Health: doctor + bridge watchdog

`amux doctor` surfaces every silent failure mode in one table: bridge
dead/hung/unsupervised, bridge running OLDER code than the repo (restart
needed), hooks broken, ledger stale, tmux unreachable. Exit codes 0/1/2
make it cron-friendly.

The bridge writes a 30s heartbeat (`~/.agentmux/bridge-heartbeat.json`).
`bin/bridge-watchdog-cron.sh` (install: `bash bin/install-bridge-watchdog.sh`,
runs every 5 min) kills a hung bridge so the supervisor restarts it, and
revives a fully dead stack only in explicit managed (`--detach`) mode.
Manual and intentionally stopped bridges stay user-owned. Rate-limited, logged to
`~/.agentmux/watchdog.log`, kill-switch `touch ~/.agentmux/watchdog-OFF`.

### Media and operator workflows

- Voice message transcription.
- Text-to-speech replies.
- File and image transfer in both directions.
- Agent-generated image attachments through `[image: /absolute/path.png]`.
- Optional Voice PWA endpoint for trusted local or tailnet clients.

### Suggestions human-comment relay

An optional one-minute poller routes unanswered human comments from public
Suggestions boards to explicit amux panes. Idle polls use no agent prompts or
model tokens; durable delivery, API-confirmed answers, bounded reminders,
untrusted-data fencing, and overlap locking are built in. See
[`docs/suggestions-comment-bridge.md`](docs/suggestions-comment-bridge.md).

## Requirements

- Linux, macOS, or WSL
- Node.js 20+
- tmux 3.2+
- At least one supported coding-agent CLI:
  - Claude Code
  - Codex CLI
- A Discord bot token if you want the Discord bridge

## Quick Start

```bash
git clone https://github.com/adelost/agentmux
cd agentmux
bash bin/setup.sh
```

The setup script checks prerequisites, installs npm dependencies, and creates
starter config files.

Create or edit `agentmux.yaml`:

```yaml
guild: "YOUR_DISCORD_SERVER_ID"
category: "Agent Cave"

agents:
  api:
    dir: ~/projects/api
    panes: 2
    codex: 1
    shells: 2

  frontend:
    dir: ~/projects/frontend
    panes: 2
```

Sessions use tmux's `tiled` layout by default, including mixed Claude, Codex,
service, and shell fleets. Set `layout:` on an agent only when that session
deliberately needs another tmux layout.

Start the bridge:

```bash
amux serve
```

This keeps logs visible in the current terminal; `Ctrl+C` stops the bridge.
For an explicitly managed background bridge, run `amux serve --detach`.
Both modes are observable with `amux doctor`.

In Discord, run:

```text
/sync
```

This creates or updates the project channels from `agentmux.yaml`.

## Discord Setup

1. Create a bot in the Discord Developer Portal.
2. Enable Message Content Intent for the bot.
3. Invite the bot to your server with permissions to send messages, read
   history, attach files, and manage channels.
4. Put the token in `.env`:

```bash
DISCORD_TOKEN=your-token-here
```

5. Put your Discord server ID in `agentmux.yaml`.
6. Start agentmux and run `/sync`.

## Everyday Commands

Discord commands:

| Command | Description |
|---|---|
| `/sync` | Create or update Discord channels from config |
| `/status` | Claude: pane/context; Codex: native account, effective model, context and rolling usage limits |
| `/switch [1\|2]` | Codex: toggle or explicitly select this pane's ChatGPT account profile |
| `/model <name> [effort]` | Codex: restart/resume this pane with process-local model settings |
| `/peek` | Show the last response from the target pane |
| `/raw` | Show raw tmux pane output |
| `/esc` | Send Escape to the target pane |
| `/dismiss` | Dismiss a blocking prompt where supported |
| `/use <agent>[.pane]` | Temporarily retarget the channel |
| `/reload` | Reload config |
| `/restart` | Restart only the bridge process |
| `/restart all` | Recreate every configured tmux session, then restart the bridge (interrupts active turns) |

Discord accepts the double-slash spelling too (`//status`, `//switch`,
`//model ...`, `//restart all`), which avoids Discord's own slash-command UI.

### Two Codex accounts

Profile 1 is the existing `~/.codex` login. Profile 2 is isolated under
`~/.config/agent/codex-profiles/2`; auth and session history never get copied
between them. Set up the second account once:

```bash
CODEX_HOME="$HOME/.config/agent/codex-profiles/2" codex login --device-auth
```

After that, `//switch` toggles only the current Codex pane and native
`//status` shows which account actually answered. `//model` uses `codex
resume --last -m ... -c ...` instead of Codex's TUI picker because the picker
persists its selection to the account-wide `config.toml`; process-local launch
overrides prevent one pane's Max/XHigh choice from changing every other pane.

Terminal commands:

```bash
amux ps
amux api -p 1 "run the test suite and summarize failures"
amux wait api -p 1
amux log api -p 1
amux log api -p 1 --tmux
amux timeline --since 30min
amux done --since 2h
amux asks --open
amux esc api -p 1
amux restart --all       # rebuild the full configured tmux fleet, even when invoked inside tmux
```

Personal todos with daily 08:00 push:

```bash
amux todo                      # list active
amux todo add "buy SSD"        # to Idag / snart
amux todo add --parked "..."   # later
amux todo done 5               # by id (or substring)
amux todo rm 5
amux todo-remind --dry         # preview push
bin/install-todo-cron.sh       # enable daily reminder
```

Backed by `~/.openclaw/workspace/memory/tasks.md`. Full docs in [`docs/todo.md`](docs/todo.md).

Suggestions comment relay:

```bash
bin/install-suggestions-comment-bridge.sh install
bin/install-suggestions-comment-bridge.sh status
bin/install-suggestions-comment-bridge.sh run-once
bin/install-suggestions-comment-bridge.sh remove
```

The default reusable mapping is `skydive -> skydive:3`. Full routing,
answer/retry, and security contract: [`docs/suggestions-comment-bridge.md`](docs/suggestions-comment-bridge.md).

`ax` is installed as a shorter alias for `amux`.

## Agent-to-Agent Delegation

Agents can use `amux` from their own terminal, so one pane can coordinate
others:

```bash
amux api -p 1 "run backend tests"
amux frontend -p 1 "audit the dashboard layout"
amux wait api -p 1
amux wait frontend -p 1
amux log api -p 1
amux log frontend -p 1
```

Generated `.agents/CLAUDE.md` and `.agents/AGENTS.md` files teach Claude Code
and Codex how to use these commands from inside project panes. They also carry
the shared ownership policy: one active ticket per agent, one end-to-end owner
per feature, and at most one risk-appropriate review before the merge broker
lands the PR and advances capacity to independent READY work. Project-specific
authority fences are generated there too: `skydive:3` autonomously manages
only `skydive:4`–`skydive:9`; reserved `skydive:0`–`skydive:2` require an
explicit per-task instruction from Mattias and never count as idle capacity.

## Configuration

Common `.env` variables:

| Variable | Default | Description |
|---|---|---|
| `DISCORD_TOKEN` | required | Discord bot token |
| `AGENTMUX_YAML` | `./agentmux.yaml` | Config file path |
| `TMUX_SOCKET` | `/tmp/agentmux.sock` | tmux socket used by agentmux |
| `TIMEOUT_S` | `600` | Max wait for a pane response |
| `TTS_VOICE` | `sv-SE-MattiasNeural` | edge-tts voice |
| `AGENTMUX_RECORD` | `0` | Save request/response recordings when set to `1` |

See `agentmux.yaml.example` for a fuller project config example.

## Documentation

- [Reliability](docs/reliability.md): Loop Guard, Drift Guard, Auto-Compact,
  and recovery commands.
- [CLI Reference](docs/cli.md): `amux` commands, log modes, timelines, and
  orchestrator commands.

## Troubleshooting

If a pane does not respond:

```bash
amux log <agent> -p <pane> --tmux
amux esc <agent> -p <pane>
amux wait <agent> -p <pane>
```

From Discord, use `/raw`, `/esc`, `/dismiss`, or `//new` for the same recovery
path.

If Discord channels are missing or stale, run `/sync` again after checking
`agentmux.yaml`.

## Tests

```bash
npm test
```

## License

MIT
