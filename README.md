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
    panes: 3                 # 3 coding agent panes = 3 Discord channels
    shells: 3                # 3 empty terminals for running commands

  another-project:
    dir: ~/projects/another
    panes: 3
    services:                # named service panes (no Discord channel)
      - npm run dev
      - npm run test
```

Each agent gets:
- `panes: N` coding agent panes (each gets a Discord channel)
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
    panes: 3
```

```yaml
# Machine B: agentmux.yaml
guild: "YOUR_SERVER_ID"
category: "Laptop"

agents:
  myproject:
    dir: ~/projects/myproject
    panes: 3
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
amux log myproject           # show last 3 turns from session jsonl (structured)
amux log myproject --tmux    # raw tmux capture (use --since / --grep to filter jsonl)
amux ps                      # show all pane statuses
amux timeline                # cross-pane event stream (kronologisk)
amux watch                   # live-tail every pane in one view
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

### `amux log` changed in 1.1.0

`amux log <agent>` now defaults to **last 3 turns from the session jsonl**,
structured as user-prompt + agent-response + tool calls. This is more reliable
than the previous filtered tmux extract (which could return empty) and gives
orchestrators structured history instead of terminal-rendered text.

| Flag | Behavior |
|---|---|
| _(default)_ | jsonl, last 3 turns |
| `-n N` | last N turns (or lines with `--tmux`) |
| `--since T` | jsonl: only turns at/after T (ISO or `30min`/`2h`/`1d`) |
| `--grep PAT` | jsonl: only turns matching regex (case-insensitive) |
| `--tmux [-s N]` | raw tmux capture, scrollback N (default 200) |
| `--full` | jsonl history + current tmux state |
| `--text` | legacy filtered extract (pre-1.1.0 default) |

If you scripted against the old default, add `--text` to keep the previous
behavior. Pane/agent validation is also stricter: out-of-bounds panes and
names like `claw:0` now error with a helpful message instead of silently
doing something wrong.

### `amux timeline` / `amux watch` (1.4.0)

`amux ps` is a snapshot, `amux log` is per-pane. For orchestrators that want
to *see every pane at once, kronologiskt*, 1.4.0 adds a unified cross-pane
stream reading directly from the session jsonl files.

```bash
amux timeline                       # last 30 events across every pane
amux timeline -n 100                # last 100 events
amux timeline --since 30min         # only events from the last 30 min
amux timeline --agent claw          # filter to one agent
amux timeline --agent claw --pane 2 # filter to one pane
amux timeline --grep "deploy"       # regex filter on content
amux timeline --follow              # live-tail (Ctrl+C to stop)

amux watch                          # shortcut for 'timeline --follow'
amux watch --agent claw --grep err  # tail one agent, only rows matching /err/i
```

Each row is one event:

```
10:42  claw:1        🎤 user   "GO — kör hela planen..."
10:43  claw:1        🤖 agent  "Kod-fix för pick-longest-duration..."
10:44  claw:5        🎤 user   "Nytt projekt: voice PWA..."
10:45  claw:1        🔧 tool   Bash git commit -m "..."
10:50  claw:1        🤖 agent  "🎉 Deploy klar (7m 54s)..."
```

Icons: 🎤 user prompt, 🤖 assistant text, 🔧 tool call, ⚠️ error. Content is
capped at 80 chars per row; use `amux log <agent> -p N --grep PAT` for the
full version of a specific turn.

`--follow` polls the jsonl files once per second (not `fs.watch`, which is
unreliable on WSL and macOS). Use it in a split pane while you work in the
other.

## Loop Guard — Bridge protects against runaway loops

Sometimes a feedback loop forms: a modal prompt fires in Claude Code, the user
accidentally presses a button 40 times, or a Discord client bug replays the
same keystroke. Each repeat bills tokens; worse, a short bot reply can itself
become input to the next loop iteration.

The bridge watches incoming Discord messages per pane. If the same short
message arrives 3 times inside a 30-second window, forwarding to the pane is
paused and a one-time warning posts in the channel:

> ⚠ Loop detected: '0' × 3 in 2s. Forwarding paused. Reply something different to resume, or run `amux esc` to clear pane state.

Subsequent identical messages inside the same block-period are silently dropped
(no warning spam). Send **any different message** to reset and resume normally.

**Tunable via `.env`:**

| Variable | Default | Purpose |
|---|---|---|
| `LOOP_GUARD_ENABLED` | `true` | Set `false` to disable entirely |
| `LOOP_GUARD_THRESHOLD` | `3` | Identical messages before blocking |
| `LOOP_GUARD_WINDOW_MS` | `30000` | Sliding window in milliseconds |
| `LOOP_GUARD_SHORT_LEN` | `10` | Messages longer than this aren't loop candidates |

The guard only watches the user → pane direction. Long messages (real prompts)
always pass through unchanged — the filter triggers only on short, repeated
text that's almost always a loop signature.

## Voice PWA support

Set `VOICE_PWA_TOKEN` to enable the HTTP endpoint for the in-car PWA:

```bash
# .env
VOICE_PWA_TOKEN=$(openssl rand -hex 32)
# optional: override defaults
VOICE_PWA_PORT=8080
VOICE_PWA_HOST=127.0.0.1   # default — local only. Set to your Tailscale IP
                           # to let your phone in via tailnet.
```

Endpoints (all authenticate with `Authorization: Bearer <token>`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/agents` | list agents + panes + labels |
| POST | `/api/send/:agent/:pane` | `{text}` or `{audio: base64, lang}` → pane |
| GET | `/api/events/:agent/:pane` | SSE: status + response when pane goes idle |
| POST | `/api/tts` | `{text}` → MP3 audio blob (edge-tts) |

Voice input is prefixed with the same `[transcribed voice, …]` disclaimer
used for Discord attachments, and mirrored to the Discord channel bound
to the pane (if any) with a `[voice-pwa]` source tag — so anyone watching
the channel sees what came in from the phone.

### Catch-up notice (stale channels)

When you return to a Discord channel that's bound to a pane and the pane
has seen activity since you last saw the channel, the bridge prepends a
short notice to your incoming message with the count plus the 3 most
recent turns:

> ℹ 10 turns since your last Discord sync (latest: 16:58)
> • 17:02 you: kör testen igen
> • 17:15 claw: All 560 tests passed
> • 18:30 you: commit och push

Count is capped at 50+ for very stale channels. Previews show the first
line of each turn (code fences collapsed to `[code]`, long text trimmed
to ~80 chars). Tool-only turns are skipped so intermediate tool chatter
doesn't crowd the preview.

### Sender auto-metadata (orchestrator → pane)

When you invoke `amux <agent> -p N "brief"` from inside a tmux session,
the receiver pane sees a `[from <session>:<window>]` header prepended
automatically, so it knows who briefed it:

```
[from claw:0]

run the full test suite
```

Detected via `$TMUX` + `tmux display -p '#S'` / `#I`. Invisible when the
caller is a raw terminal, Discord bot, or cron job (no TMUX env). Opt
out per-call with `--no-meta` when the header would be noise (e.g.
plain ack pings). Discord mirror carries the same header so channel
watchers see which pane originated each brief.

Binds to `127.0.0.1` by default to avoid exposure before you're ready.
Flip to your Tailscale IP (e.g. `100.x.y.z`) when you want the phone to
reach it. For public access later, put it behind a Cloudflare Tunnel
without code changes.

## Orchestrator primitives

When a Claude pane drives several other panes (`amux <agent> -p N "..."`),
two commands answer the two questions that come up most:

### `amux done` — "what's been resolved since I last checked?"

```bash
amux done                    # defaults to last-checkpoint anchor (1h fallback)
amux done --since last       # explicit: use checkpoint
amux done --since 30min      # override anchor
amux done --reset            # peek without advancing the checkpoint
```

Output groups panes into four buckets:

```
✅ 2 finished                          committed work / idle with turns
🔴 2 waiting your input                last assistant msg ends with a question
🟡 1 still working                     live status = working/resume
💤 30 idle                             no activity since cutoff
```

State lives in `/tmp/agentmux-orchestrator-check.json` as a single
`last_check_ts_ms` field. Every successful `amux done` advances it (pass
`--reset` to peek). Override path via `AMUX_CHECKPOINT_PATH` env var.

### `amux timeline --by-pane` — "what happened, chronologically, grouped?"

Complement to plain `amux timeline` (flat chronological stream). `--by-pane`
groups rows under `agent:pane` headers, sorted by newest activity first.
Use for post-mortem analysis; use `amux done` for daily orchestration.

```bash
amux timeline --since 2h --by-pane
amux timeline --since 1h --by-pane --agent claw --grep "commit"
```

## Auto-compact

Background poll in the bridge warns + fires `/compact` on idle, high-context
panes so conversations don't drift into panic-compact at 95%. Runs once per
pollMs, warns once per threshold-crossing, fires after graceMs if the pane
is still idle. Any activity (new turn, copy-mode entered, context drops)
cancels the pending warning.

```
⚠ Auto-compact in 60s: claw:3 is at 78% context and idle. Type anything to cancel.
... (60s of silence) ...
🗜 Auto-compacting claw:3 (was 78%). Summary preserves recent context.
```

Env vars (all optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_COMPACT_ENABLED` | `true` | Set to `false` to disable the loop |
| `AUTO_COMPACT_WARN_THRESHOLD` | `70` | Context % that triggers a warning |
| `AUTO_COMPACT_GRACE_MS` | `60000` | Ms between warning and fire |
| `AUTO_COMPACT_POLL_MS` | `60000` | Ms between poll ticks (matched to grace by default) |

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
- If the agent is stuck, type `/esc` to interrupt and try again
- Surveys are suppressed automatically (`ANTHROPIC_DISABLE_SURVEY=1`) and auto-dismissed by the retry loop. If you still see one (e.g. from a session started before agentmux), type `/dismiss`

**Restarting a stuck Claude session**
- Send `//new` in the Discord channel to start a fresh Claude session
- Or attach directly: `tmux -S /tmp/agentmux.sock attach -t myproject` and fix manually

## Tests

```bash
npm test
```

## License

MIT
