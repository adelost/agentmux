# agentmux

Discord bridge for tmux-based coding agents. Send messages in Discord, get responses from Claude Code (or Codex) running in tmux panes.

```
You (phone/desktop)
  -> Discord message
agentmux (Node.js)
  -> tmux send-keys
Claude Code (in tmux pane)
  -> works...
agentmux reads session jsonl
  -> extracts structured response
You (Discord)
  -> reply with context %
```

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

- **jsonl source of truth**: Reads Claude Code's session jsonl files directly for response extraction and busy detection. No tmux text parsing, no wordwrap bugs, no progress-icon interference. Codex rollout files supported too.
- **Multi-agent**: Route different Discord channels to different coding agents
- **Multi-pane**: Multiple Claude Code instances per project
- **Channel sync**: `/sync` creates Discord channels from config
- **Streaming**: Real-time progress updates while agent works
- **Follow mode**: Stream output even when typing directly in tmux
- **Session isolation**: Each pane gets its own Claude session in `.agents/N/`
- **Voice**: Send voice messages (transcribed via Whisper)
- **TTS**: Text-to-speech for responses (with automatic speech-friendly formatting hints)
- **Attachments**: Images, PDFs, documents, and any file type forwarded to the agent
- **Context tracking**: Model-aware context window usage (supports 1M-context Opus/Sonnet)
- **Recording**: Saves request/response pairs for replay testing (auto-rotation, max 500)
- **Auto-restart**: Crash recovery via `bin/start.sh`
- **Auto-dismiss**: Handles resume prompts and feedback surveys automatically

## Session Isolation

Claude Code ties session history to the working directory. When multiple panes share the same dir, `--continue` picks up the wrong session.

agentmux solves this automatically:
- **Pane 0** runs in the project root
- **Pane 1+** runs in `root/.agents/N/`

Each pane gets isolated session history. `--continue` is safe on all panes. `.agents/` is auto-added to `.gitignore`. Claude Code searches upward for `CLAUDE.md`, so all panes read the project config.

## tmux Integration

agentmux creates tmux sessions you can attach to directly:

```bash
# If you have the agent CLI (optional)
agent myproject              # attach to tmux session
agent myproject "fix bug"    # send prompt from terminal

# Or use tmux directly
tmux -S /tmp/agentmux-tmux.sock attach -t myproject
```

## Environment Variables

All optional (set in `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_TOKEN` | (required) | Discord bot token |
| `AGENTMUX_YAML` | `./agentmux.yaml` | Path to config |
| `TMUX_SOCKET` | `/tmp/agentmux-tmux.sock` | tmux socket path |
| `TIMEOUT_S` | `600` | Max wait for response (seconds) |
| `TTS_VOICE` | `sv-SE-MattiasNeural` | edge-tts voice |
| `AGENTMUX_RECORD` | `0` | Set to `1` to save request/response recordings |

## Tests

```bash
npm test     # 390 tests
```

## License

MIT
