# Agentus

Discord bridge for tmux-based coding agents. Send messages in Discord, get responses from Claude Code running in tmux.

```
Discord message → Agentus → tmux pane (Claude Code) → response → Discord
```

## Quick Start

### Setup

```bash
git clone https://github.com/adelost/agentus
cd agentus
bash bin/setup.sh
```

The setup script checks and installs prerequisites (Node.js 20+, tmux, yq, jq, Claude Code), runs `npm install`, and creates config files.

After setup, add your Discord token to `.env` and configure `agents.yaml`.

### Create a Discord Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. New Application > name it > Bot > Reset Token > copy token to `.env`
3. Bot > enable **Message Content Intent**
4. OAuth2 > URL Generator > select `bot` scope > select permissions: Send Messages, Read Message History, Attach Files
5. Open the generated URL to invite the bot to your server

### Configure agents.yaml

Map Discord channels to tmux sessions. Each agent runs Claude Code in a tmux pane.

```yaml
myproject:
  dir: /home/you/projects/myproject
  id: 00000000-0000-0000-0000-000000000001
  discord: "CHANNEL_ID_HERE"
  panes:
    - name: claude
      cmd: claude --continue --dangerously-skip-permissions
```

Get channel IDs: Discord Settings > Advanced > Developer Mode, then right-click channel > Copy Channel ID.

See `agents.yaml.example` for multi-pane setups.

### Run

```bash
# Production (with auto-restart on crash)
npm run dev

# Simple (no restart loop)
npm start
```

## Commands

Type these in a mapped Discord channel:

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
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
| `/reload` | Reload agents.yaml |
| `/restart` | Restart Agentus |

Prefix with `.N` to target a specific pane: `.1 fix the bug`

## Features

- **Multi-agent**: Route different Discord channels to different coding agents
- **Multi-pane**: Multiple Claude Code instances per project (e.g. frontend + backend)
- **Streaming**: Real-time progress updates while agent works
- **Follow mode**: Stream output even when typing directly in tmux
- **Voice**: Send voice messages, transcribed via Whisper
- **Attachments**: Send images/files, passed to the agent
- **TTS**: Text-to-speech responses (edge-tts)
- **Context tracking**: Shows context window usage %
- **Auto-restart**: Crash recovery via `bin/start.sh`

## How It Works

```
You (Discord)
  ↓ message
Agentus (Node.js)
  ↓ bin/agent <name> <prompt>
tmux session
  ↓ send-keys to pane
Claude Code (running in pane)
  ↓ works...
Agentus polls tmux
  ↓ extracts response
You (Discord)
  ↓ reply
```

Agentus doesn't run Claude Code itself. It connects to existing tmux sessions where Claude Code is already running (or starts them on first message).

## Tests

```bash
npm test
```

## License

MIT
