# AMUX Code

AMUX Code is the browser-native Claude Code and Codex path for agentmux. It
does not type into tmux or scrape a terminal. The local server talks to Claude
Code over bidirectional stream JSON and to Codex over its app-server protocol,
streams machine-readable events to the browser and resumes each engine's
native session on the next operation.

## Run

```bash
node spikes/web-ui/server.mjs
```

The server listens only on `127.0.0.1:8811`. To use it from another device,
publish that loopback endpoint with Tailscale Serve; do not bind the service to
a public interface.

The HTML, CSS and browser JavaScript are snapshotted when the process starts so
they always match the running backend. Restart the server to activate a new
release; editing files in the checkout cannot partially update the live UI.

Optional environment variables:

- `AMUX_WEB_PORT`: loopback port (default `8811`)
- `AMUX_WEB_DATA_DIR`: registry and upload directory (default
  `~/.agentmux/web-ui`)
- `AMUX_WEB_CLAUDE_COMMAND` / `AMUX_WEB_CODEX_COMMAND`: alternate CLI binary

## Persistence and permissions

Projects store a name and an existing trusted working directory. Every agent
in a project inherits that directory. AMUX Code persists only its project and
agent registry, idempotency receipts, uploaded files and the engines' native
session ids. Conversation history stays in Claude Code's and Codex's own JSONL
session files and is hydrated from those files after a restart.

Closing the browser does not stop an active turn. Claude Code runs in
`acceptEdits` mode so edits and ordinary project commands can complete without
an invisible permission dialog; Codex keeps its configured sandbox and
approval policy. This uses the same local CLI authentication/subscription as
an ordinary terminal session, not a separate cloud API key.

## Runtime controls

Effort is selected when an agent is created and can be changed from its header.
Changing it during a running turn leaves that turn unchanged and applies the
new value to the next turn.

The context meter is the current native conversation context, not an account or
subscription quota. Claude reports it through `modelUsage`; Codex reports it
through `thread/tokenUsage/updated`. The UI shows current tokens/window, the
most recent input/output counts and cumulative processed tokens. A restored
Claude session can show tokens without a percentage until Claude reports its
context-window size on the next turn.

`Avbryt` uses the engines' native soft-interrupt commands. It stops the active
turn without deleting the native session, so the next message resumes the same
conversation. `Compact` invokes native compaction (`/compact` for Claude and
`thread/compact/start` for Codex), rather than asking the model to summarize in
an ordinary prompt.

An idle agent at or above 60% context is compacted automatically after five
minutes. Starting any new turn or manual operation cancels the idle timer;
automatic compaction never starts while an agent is running.

Claude side questions use a non-persistent fork of the current native session.
This provides the context-preserving effect of `/btw` without changing or
interrupting the main session.

The project registry includes a versioned communication-policy seam. History
is readable across the project's agents today; per-agent send ACL enforcement
is intentionally deferred.

## Design language and visual gate

The UI shares design tokens with Suggest (`suggestions-v1d/src/style.css`):
the canvas/paper/ink palette, Inter, 1px hairlines, soft status colors and the
same button recipes, in both light and dark (`prefers-color-scheme`). The
design is deliberately flat: depth (shadow) is reserved for true overlays
(dialogs, the side panel, toasts); everything in flow separates with lines and
paper tiers. When adjusting styles, change tokens first and components second,
and keep the two products visually in sync.

```bash
npm run test:webui:visual
```

boots the real server against a seeded temp registry, renders the snapshot
view in headless Chrome at desktop (1280x800) and mobile (375x740) and fails
on horizontal overflow, invisible core surfaces (header controls, composer,
conversation), controls without an accessible name, a composer that is not
flush with the viewport at reading position, or any page error. Screenshots
land in `spikes/web-ui/artifacts/` (gitignored) as review evidence. It needs a
local Chrome/Chromium (`CHROME_BIN` overrides autodetection) and is therefore
a separate script rather than part of the default `npm test`.
