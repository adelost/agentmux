# AMUX Code

AMUX Code is the browser-native Claude Code and Codex path for agentmux. It
does not type into tmux or scrape a terminal. The local server starts one
official CLI process for each turn, streams its machine-readable events to the
browser and resumes the engine's native session on the next turn.

## Run

```bash
node spikes/web-ui/server.mjs
```

The server listens only on `127.0.0.1:8811`. To use it from another device,
publish that loopback endpoint with Tailscale Serve; do not bind the service to
a public interface.

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

Claude side questions use a non-persistent fork of the current native session.
This provides the context-preserving effect of `/btw` without changing or
interrupting the main session.

The project registry includes a versioned communication-policy seam. History
is readable across the project's agents today; per-agent send ACL enforcement
is intentionally deferred.
