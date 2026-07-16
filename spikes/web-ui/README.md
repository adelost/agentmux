# AMUX Code

AMUX Code is the browser-native Claude Code and Codex path for agentmux. It
does not type into tmux or scrape a terminal. The local server talks to Claude
Code over bidirectional stream JSON and to Codex over its app-server protocol,
streams machine-readable events to the browser and resumes each engine's
native session on the next operation.

## Run

```bash
amux runtime start
amux runtime status
```

For foreground development, `node spikes/web-ui/server.mjs` remains available.

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
- `AMUX_WEB_LEGACY_DATA_DIR`: legacy spike history source; set to `off` for an
  isolated runtime (the native canary does this automatically)
- `AMUX_WEB_CLAUDE_COMMAND` / `AMUX_WEB_CODEX_COMMAND`: alternate CLI binary

## Persistence and permissions

Projects store a name and an existing trusted working directory. Every agent
in a project inherits that directory. AMUX Code persists only its project and
agent registry, idempotency receipts, uploaded files and the engines' native
session ids. Conversation history stays in Claude Code's and Codex's own JSONL
session files and is hydrated from those files after a restart.

The registry also contains a bounded delivery journal for accepted prompts.
The receipt is written before an engine turn starts and keeps a clipped
500-character preview, target snapshots, source and terminal status. The
browser reads this one journal at three scopes: all projects, the selected
project or the selected agent. Discord and `amux` deliveries write through the
same `/messages` acceptance seam; `amux asks` may consume it later but is not a
second writer or the source of truth.

Messages accepted while an agent is already running enter a bounded,
persisted per-agent FIFO. The browser composer remains enabled, displays the
queue count and gives every queued prompt its own idempotency receipt. FIFO
entries retain their full payload only until their turn finishes; the durable
journal keeps the existing clipped preview. A runtime restart after submission
is reported as an uncertain failure instead of automatically replaying a turn
that may already have changed the workspace.

The browser UI is English-only. Images copied to the clipboard can be pasted
directly into the prompt composer; they use the same bounded, idempotent upload
path and attachment preview as the file picker and drag-and-drop.

Claude and Codex tool calls share one browser activity format. Running,
completed and failed calls appear as compact disclosure rows with a timestamp,
duration and bounded input/result previews. The server never forwards a raw
tool payload to the browser: file operations expose paths instead of patch
bodies, previews are clipped, and common credential keys and token formats are
redacted. The same projection is used for live events and hydrated native
history so a restart does not change what the browser can see.

Closing the browser does not stop an active turn. Agents created manually in
the GUI use Claude `acceptEdits` and the locally configured Codex sandbox.
Bridge-provisioned canary agents are marked `automation`: Claude uses native
`auto` permission review with Chrome integration disabled, while Codex uses a
network-enabled workspace sandbox plus its native auto reviewer. The modes
cannot be confused silently because they are persisted in the registry and included in
the idempotent create fingerprint. Model and effort are mutable next-turn
settings and are reconciled only through the settings endpoint, never through
that stable identity receipt. Both use the local CLI authentication/subscription,
not separate cloud API keys.

Codex profiles also receive a managed execpolicy defense-in-depth rule. It
deterministically blocks direct host GUI/browser launch commands and interactive
Playwright entry points; ordinary headless Playwright tests are unaffected.
This prefix policy is deliberately not described as a complete process sandbox:
the workspace sandbox and ticket-intake SafetyHold remain separate boundaries.

## Discord/tmux compatibility pilot

An agentmux source entry with `backend: native` is provisioned idempotently in
this registry with its stable `agent:pane` address. Discord and `amux send`
continue to use the existing durable FIFO. The delivery job id becomes the
native message key: if the bridge loses an HTTP response after acceptance, its
retry replays the same receipt and never launches a second turn. Attachments
are copied through the existing durable asset spool and uploaded idempotently
before the message is accepted.

The native watcher mirrors completed runtime operations to the configured
Discord channel and persists content-addressed turn receipts across bridge
restarts. Native token/idle data owns auto-compact; terminal auto-compact,
drift and Playwright scrapers skip the target. `amux ps`, `top`, `wait`, `log`,
`esc`, targeted `compact`, `doctor`, `revive`, sender provenance and `/sync`
all understand the native backend. Fleet-wide tmux restart explicitly excludes
it. There is no automatic native-to-tmux fallback.

The real-engine release gate uses its own loopback port, registry, queue and
workspace and refuses the default runtime port:

```bash
npm run test:webui:native-canary -- --port 8812
```

It provisions only `skybar-canary` and proves durable attachment delivery,
context usage, next-turn effort changes, Claude/Codex soft interrupt, resume,
manual compact, runtime restart, event-ledger state and duplicate-free Discord
projection. Its final M3 phase stops only that isolated runtime, resumes both
exact engine session IDs in an isolated tmux socket, flips back to native and
requires `replayed: true` with no duplicate turn. It fails if a canary session
appears on the live/default tmux socket.

The narrower Claude process-lifecycle canary compares the current
spawn-plus-resume behavior with one long-lived bidirectional stream-json
process. It uses subscription authentication only, defaults to Haiku, verifies
same-process/same-session turns, soft interrupt and post-interrupt recovery,
and reports cache-creation receipts for turns 2-3. It never changes a fleet or
starts tmux:

```bash
npm run test:webui:claude-process-canary
```

This is an opt-in live canary because it consumes real Claude subscription
usage. The default test suite runs the same lifecycle against a deterministic
fake CLI and consumes no model quota.

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

Conversations can be pinned from the agent header. `pinnedAt` is persisted on
the agent/native-session record, and the global Pinned overview jumps directly
to the owning project and instance after a browser or runtime restart.

The color theme follows the operating-system preference until the user chooses
light or dark from the top bar. That explicit choice is browser-local,
persists across reloads and synchronizes across tabs; it is presentation state
and never becomes project or server configuration.

The project registry includes a versioned communication-policy seam. History
is readable across the project's agents today; per-agent send ACL enforcement
is intentionally deferred.

## Design language and visual gate

The UI shares design tokens with Suggest (`suggestions-v1d/src/style.css`):
the canvas/paper/ink palette, Inter, 1px hairlines, soft status colors and the
same button recipes, in both light and dark. The initial theme follows
`prefers-color-scheme`, while the top-bar control can persist an explicit
browser-local choice. The
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
conversation), broken all/project/instance prompt filters, missing pinned
conversation navigation, broken image paste or duplicate upload, controls
without an accessible name, a composer that is not flush with the viewport at
reading position, or any page error. Screenshots
land in `spikes/web-ui/artifacts/` (gitignored) as review evidence. It needs a
local Chrome/Chromium (`CHROME_BIN` overrides autodetection) and is therefore
a separate script rather than part of the default `npm test`.
