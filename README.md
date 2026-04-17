# agentmux

Control Claude Code and Codex agents from your phone via Discord.

```
Discord message → agentmux → Claude Code (tmux) → response → Discord reply
```

- **Voice in, text out** - send voice messages, get them transcribed and processed
- **Text in, voice out** - TTS reads responses back to you
- **Send files, get images** - screenshots, PDFs, code files in both directions
- **Multi-agent orchestration** - agents delegate tasks to each other via `amux` CLI
- **Works from anywhere** - phone, tablet, another machine. Just open Discord.

Works on Linux, macOS, and WSL. Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

## Quick Start

```bash
git clone https://github.com/adelost/agentmux
cd agentmux
bash bin/setup.sh
```

Setup checks prerequisites (Node.js 20+, tmux, Claude Code), installs npm deps, and creates config files. Then follow these steps:

### 1. Create a Discord Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application**, name it (e.g. "agentmux")
3. Go to **Bot** in the sidebar
4. Click **Reset Token**, copy the token
5. Paste it in `.env` as `DISCORD_TOKEN=your-token-here`
6. Scroll down and enable **Message Content Intent**
7. Go to **OAuth2 > URL Generator** in the sidebar
8. Check **bot** under Scopes
9. Check these Bot Permissions: **Send Messages**, **Read Message History**, **Attach Files**, **Manage Channels**
10. Copy the generated URL at the bottom, open it in your browser
11. Select your Discord server and authorize

### 2. Get your Discord Server ID

1. Open Discord Settings > App Settings > **Advanced** > enable **Developer Mode**
2. Right-click your server name in the sidebar > **Copy Server ID**

### 3. Configure agentmux.yaml

Edit `agentmux.yaml` with your server ID and projects:

```yaml
guild: "YOUR_SERVER_ID"
category: "Agent Cave"       # Discord category for agent channels

agents:
  myproject:
    dir: ~/projects/myproject
    claude: 3                # 3 Claude Code panes = 3 Discord channels
    shells: 3                # 3 empty terminals for running commands

  another-project:
    dir: ~/projects/another
    claude: 3
    services:                # named service panes (no Discord channel)
      - npm run dev
      - npm run test
```

Each agent gets:
- `claude: N` panes with Claude Code (each gets a Discord channel)
- `services:` for background commands (dev server, etc.)
- `shells: N` empty terminals for manual use

### 4. Start and Sync

```bash
npm run dev                  # start agentmux (with auto-restart)
```

Then in any existing Discord channel where the bot is present, type:

```
/sync
```

This creates all the Discord channels automatically under the configured category. You only need to run `/sync` once (or when you change `agentmux.yaml`).

### 5. Start coding via Discord

Send a message in any created channel (e.g. `#myproject`):

```
fix the bug in auth.ts
```

agentmux sends it to Claude Code, streams progress, and replies with the result.

## Multi-machine setup

Each machine runs its own agentmux instance. To avoid conflicts, use a separate Discord category per machine:

```yaml
# Machine A: agentmux.yaml
guild: "YOUR_SERVER_ID"
category: "Desktop"

agents:
  myproject:
    dir: ~/projects/myproject
    claude: 3
```

```yaml
# Machine B: agentmux.yaml
guild: "YOUR_SERVER_ID"
category: "Laptop"

agents:
  myproject:
    dir: ~/projects/myproject
    claude: 3
```

Both connect to the same Discord server but create channels under different categories. No conflicts, same bot token works.

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/sync` | Create/sync Discord channels from agentmux.yaml |
| `/peek` | Last response from agent |
| `/raw` | Last 50 lines of tmux pane (raw) |
| `/status` | Current agent, pane, context% |
| `/follow` | Toggle: stream output even when typing in tmux |
| `/thinking` | Toggle real-time text streaming |
| `/tts` | Toggle text-to-speech |
| `/dismiss` | Dismiss blocking prompt (survey etc.) |
| `/esc` | Send Escape to interrupt agent |
| `/use <agent>[.pane]` | Switch channel target |
| `/use reset` | Back to yaml default |
| `/reload` | Reload config |
| `/restart` | Restart agentmux |

**Pane targeting:** prefix with `.N` to target a specific pane: `.2 fix the bug` sends to pane 2.

**Claude commands:** any `//command` that isn't an agentmux command is forwarded to Claude as a slash command. `//compact`, `//clear`, `//new`, `//model sonnet` etc. all work.

## Features

**Core**
- Multi-agent routing (different Discord channels to different projects)
- Multi-pane (multiple Claude Code instances per project)
- `/sync` auto-creates Discord channels from config
- Session isolation (each pane gets its own Claude session in `.agents/N/`)

**Reliability**
- jsonl source of truth for response extraction (no tmux parsing bugs)
- Retry loop with echo verification for prompt delivery
- Auto-dismiss surveys and blocking prompts
- Auto-restart on crash (`bin/start.sh`)
- Context tracking (model-aware, supports 1M-context Opus/Sonnet)

**Media**
- Voice messages (transcribed via Whisper)
- Text-to-speech responses
- Image/PDF/document attachments (both directions)
- Agent can attach images via `[image: /path/to/file.png]`

**Orchestration**
- `amux` CLI for agent-to-agent communication
- Auto-generated hints (`.agents/CLAUDE.md` + `.agents/AGENTS.md`)
- Agents discover commands automatically, survives `/compact`
- Fan-out parallel work across agents

## Session Isolation

Claude Code ties session history to the working directory. When multiple panes share the same dir, `--continue` picks up the wrong session.

agentmux solves this automatically:
- **Pane 0** runs in the project root
- **Pane 1+** runs in `root/.agents/N/`

Each pane gets isolated session history. `--continue` is safe on all panes. `.agents/` is auto-added to `.gitignore`. Claude Code searches upward for `CLAUDE.md`, so all panes read the project config.

agentmux auto-generates `.agents/CLAUDE.md` and `.agents/AGENTS.md` with CLI commands and orchestration hints. Claude Code reads `CLAUDE.md` and Codex reads `AGENTS.md`, both searching upward from the pane's working directory. These files survive `/compact` because they are loaded as system context, not conversation history.

## CLI (`amux`)

After `npm link` (or global install), the `amux` command manages agent sessions:

```bash
amux                         # list all agents
amux myproject               # attach to tmux session
amux myproject "fix the bug" # send prompt from terminal
amux wait myproject          # wait until agent is idle
amux log myproject           # show last response
amux ps                      # show all pane statuses
amux esc myproject           # interrupt an agent
```

Or attach directly via tmux:

```bash
tmux -S /tmp/agentmux.sock attach -t myproject
```

## Agent orchestration

Agents can orchestrate other agents from their terminal using `amux`. agentmux auto-generates `.agents/CLAUDE.md` and `.agents/AGENTS.md` so agents discover the commands automatically (Claude Code and Codex respectively).

**Example: delegate tests to another agent**
```bash
# From agent A's terminal
amux api "run all tests and report failures"
amux wait api
amux log api
```

**Example: check what all agents are doing**
```bash
amux ps
```

**Example: fan-out work**
```bash
# Send tasks to multiple agents in parallel
amux frontend "update the dashboard component" &
amux backend "add the new API endpoint" &
wait
# Both agents work simultaneously
```

This makes it possible to build workflows where one agent coordinates others, similar to a lead developer delegating tasks to a team.

## Environment Variables

All optional (set in `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_TOKEN` | (required) | Discord bot token |
| `AGENTMUX_YAML` | `./agentmux.yaml` | Path to config |
| `TMUX_SOCKET` | `/tmp/agentmux.sock` | tmux socket path |
| `TIMEOUT_S` | `600` | Max wait for response (seconds) |
| `TTS_VOICE` | `sv-SE-MattiasNeural` | edge-tts voice ([list](https://gist.github.com/BettyJJ/17cbaa1de96235a7f5773b8571c32980)) |
| `AGENTMUX_RECORD` | `0` | Set to `1` to save request/response recordings |

## Troubleshooting

**Agent not responding / "did not acknowledge prompt"**
- Type `/raw` in the Discord channel to see what the tmux pane looks like
- If you see a survey ("How is Claude doing?"), type `/dismiss` to clear it
- If the agent is stuck, type `/esc` to interrupt and try again
- Claude Code surveys are suppressed automatically (`ANTHROPIC_DISABLE_SURVEY=1`), but existing sessions started before agentmux need a restart to pick it up

**Restarting a stuck Claude session**
- Send `//new` in the Discord channel to start a fresh Claude session
- Or attach directly: `tmux -S /tmp/agentmux.sock attach -t myproject` and fix manually

## Tests

```bash
npm test
```

## License

MIT
