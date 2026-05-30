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
- Retry loop with delivery verification.
- Resume hints for panes that restart without prior context.
- Model-aware context tracking.
- Recovery commands for stuck panes and blocking prompts.

### Media and operator workflows

- Voice message transcription.
- Text-to-speech replies.
- File and image transfer in both directions.
- Agent-generated image attachments through `[image: /absolute/path.png]`.
- Optional Voice PWA endpoint for trusted local or tailnet clients.

## Requirements

- Linux, macOS, or WSL
- Node.js 20+
- tmux
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

Start the bridge:

```bash
npm run dev
```

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
| `/status` | Show current agent, pane, and context usage |
| `/peek` | Show the last response from the target pane |
| `/raw` | Show raw tmux pane output |
| `/esc` | Send Escape to the target pane |
| `/dismiss` | Dismiss a blocking prompt where supported |
| `/use <agent>[.pane]` | Temporarily retarget the channel |
| `/reload` | Reload config |
| `/restart` | Restart the bridge process |

Terminal commands:

```bash
amux ps
amux api -p 1 "run the test suite and summarize failures"
amux wait api -p 1
amux log api -p 1
amux log api -p 1 --tmux
amux timeline --since 30min
amux done --since 2h
amux esc api -p 1
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
and Codex how to use these commands from inside project panes.

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
