// The amux tool guide: how any pane drives the mux, reads other panes,
// reaches the human and keeps the bridge healthy. Pure tooling — fleet
// process rules live in hints-fleet-process.mjs, board coordination in the
// suggestions repo (docs/AGENT-WORK-PROTOCOL.md), repo truths in each
// repo. Assembled into the versioned hints block by agent.mjs.
// WHAT: Defines the tool-guide section of the generated agent policy. WHY: Separates the amux tool surface from the process rules that live one layer up.
export const TOOL_GUIDE_HINTS = `# agentmux

You are running inside agentmux. You can orchestrate other agents from your terminal.

**Never use raw \`tmux ... capture-pane\`.** Everything is exposed via \`amux\`:
shorter, validated, mirrors to Discord so the user sees what you do.

> Tip: \`ax\` is a shorter alias for \`amux\` (same script, both work). Use either.

## Cheat sheet (intent-first)

### Send a task to another pane
\`\`\`bash
amux <agent> -p <pane> "prompt"      # -p default 0
amux claw -p 1 "run the full test suite"
\`\`\`
Mirrors to Discord channel automatically (user sees your briefs). Auto-prepends
\`[from <sender-session>:<window>]\` when invoker is in tmux; receiver pane +
Discord mirror both see who briefed. Sender is invariant: provenance is never
silently erased.

### See what a pane has done
\`\`\`bash
amux log <agent> -p <pane>           # default: last 3 turns from jsonl
  -n 5                               # more turns
  --since 30min                      # only recent
  --grep "deploy"                    # filter content
  --tmux -s 200                      # raw terminal, scrollback depth
  --full                             # jsonl + tmux combined
\`\`\`
\`amux log\` defaults to jsonl (structured history). Use \`--tmux\` only when you
need to see live terminal state (progress bars, modal prompts, etc).

### Search memory + history (use this BEFORE asking the human "what was X?")
\`\`\`bash
amux search "Tess"                   # ranked overview: memory, sessions, ledger
amux search "vad bestämdes om X"     # fast lexical search is the current default
amux search "vad bestämdes om X" --semantic # optional paraphrase layer
amux search --show 3                 # expand hit #3 with context
amux search "term" --deep           # include large raw session archives
amux search --reindex                # explicitly rebuild the semantic index
\`\`\`
One line per hit, best sources first (memory > digests > raw sessions).
When the user references a person, project or decision you lack context on,
search FIRST: the answer is usually already in memory. \`claw search\` is
the same engine.

### Find asks and unfinished human directives
\`\`\`bash
amux asks                            # durable asks + bounded live status
amux asks --open                     # unresolved only
amux asks <agent> --pane N --since 2d
amux asks --all-repos --summary      # durable overview across removed/current repos
amux asks --full --since 30d         # exact live reply/line join; prompts are already durable
\`\`\`
Use \`asks\` for "what did Mattias ask, where, and did it close?". The
append-only ask ledger survives respawn, clear, rotation, and janitor; missing
provider history is shown honestly as archived. \`--full\` only expands the
optional live-session status/line join.

### Understand state across panes
\`\`\`bash
amux ps                              # status + context% + tokens per pane
amux top                             # leaderboard sorted by % desc
amux timeline                        # all events across panes, chronological
amux timeline --agent claw --since 1h --grep "commit"
amux timeline --since 2h --by-pane   # grouped under pane headers (analysis view)
amux watch                           # live-follow (like tail -f)
\`\`\`

### Notify the human
\`\`\`bash
amux notifyuser "klart med deploy"           # mobile push via DM/#notify
amux notifyuser --level error "Dream failed" # high-signal alert
amux claw -p 2 --notify-user "run tests"     # ping human when pane is done/problem
\`\`\`
Use this only when the user explicitly asks to be notified, or when something
is genuinely important and needs the user's attention soon (failure, blocked
permission, production risk, completed long-running task he asked to track).
Do not use it for routine progress, minor status updates, or "nice to know"
messages.

### Know what's happening (orchestrator overview)
\`\`\`bash
amux done                            # default: last 1h
amux done --day                      # last 24h
amux done --week                     # last 7 days
amux done --all                      # last 30d (max safety cap)
amux done --since 30min              # explicit window: ISO or relative ("2h", "1d")
\`\`\`

\`amux done\` is **pure time-window**: no state, no checkpoint, fully
idempotent. Call it as many times as you want; output is consistent.
Multiple agents can run it in parallel without races.

Output anatomy (same for all modes):

1. **\`▸ DU = <agent>:<pane>\`**: only when you run \`done\` from inside a pane.
   Your own state first: what you were last asked, your last reply, your status,
   and \`amux log\` for your full history. If you just lost context (compact /
   fresh spawn), this re-anchors you before anything else.
2. **\`Recent activity (top 20)\`**: last 20 events system-wide from a 7d
   window, independent of cutoff. 📝 commits + 🔸 pane activity, newest first.
   "Where were we" at a glance.
3. **Attention-first sections**: open loops over a WIDER window (old dropped
   balls surface), live state over the cutoff:
   - 📝 **Commits**: work shipped (strongest signal)
   - 🔴 **väntar på DITT svar / needs you**: agent asked the human a question,
     or a live modal. Ball is in the human's court.
   - ⚠️ **kanske tappad / maybe dropped**: the human's directive is the most
     recent message and the agent never replied + isn't live (idle >30min). This
     is the "I asked X, it never got done" detector.
   - 🟡 **jobbar / working**: live right now.
   - ✅ **klar / done**: replied within the window.
   - 💤 **idle**: counted.

   Each pane shows a 2-line **thread block** (age tag on actionable sections):
   \`\`\`
   claw:9   13:02  +164t  · 3h sen
      ← <last directives it received>     (≤3, oldest→newest; [from X] = inter-agent)
      → <its latest reply>
   \`\`\`
   The coordination payload: what a pane was told + where it landed, WITHOUT a
   follow-up \`amux log\`. Read a pane's ← line to see if it's already on your
   task. Sections cap at 8 rows (\`… +N\` → \`amux done --week\`).
4. **\`ℹ More:\`** footer: drill-down + send-to-pane + \`timeline --grep\` to find
   which pane you asked about something.

Use \`amux done\` at every decision point instead of 5× \`amux ps\` + per-pane
\`amux log\`: the feed gives "where was I", the thread blocks give "what is
everyone doing and what were they asked", 🔴/⚠️ give "what needs me / what got
dropped": enough to coordinate, or to recover a dropped ball by handing it to
another pane, from one call.

### Shrink context before hitting limit
\`\`\`bash
amux compact                         # /compact panes >=20% and >=200k tokens
amux compact --dry                   # preview, no action
amux compact --force                 # include working panes (dangerous)
\`\`\`
Bulk-compact affects idle panes. Skips working/permission/menu states.

### Nightly memory digest
\`\`\`bash
amux dream                           # write/update memory/YYYY-MM-DD.md pane digest
amux dream --dry                     # preview, no action
amux dream --since 24h
bin/dream-cron.sh                    # cron wrapper: run + validate output
\`\`\`
Meant for cron at 04:00. It asks each active pane to update only its own
marker block in the daily memory file, then writes a run sentinel.

Dream also runs **session-file housekeeping** at the end of each nightly run:
DEAD session jsonl (mtime older than 14d, Claude + Codex) get deleted. Live
files are never matched: an active pane rewrites its jsonl continuously, so
its mtime is always seconds old. This only reaps abandoned/rotated sessions;
it does NOT and cannot shrink a live 100MB+ session (that's a \`/compact\` job;
truncating a live file would corrupt resume). Inspect or run on demand:
\`\`\`bash
amux janitor --dry                   # what would be deleted (no changes)
amux janitor --days 30               # custom retention window
amux janitor                         # delete now
\`\`\`
Deletions are logged to \`~/.claude/projects/.janitor-deleted.log\`. Disable the
nightly pass with \`AMUX_JANITOR_ENABLED=false\`; tune with
\`AMUX_JANITOR_RETENTION_DAYS\`. Note: \`claw search\` then only covers the last
14d of sessions.

### Auto-compact (background, bridge-driven)
Idle panes >=70% context get warned (Discord channel), then /compact:ed
after 60s grace unless activity cancels. Requires 5 min conversation
silence before warning (AUTO_COMPACT_MIN_IDLE_MS) so between-turns pauses
don't trigger. Poll every 60s. Disable via \`AUTO_COMPACT_ENABLED=false\`.
Tune via \`AUTO_COMPACT_WARN_THRESHOLD\`, \`AUTO_COMPACT_GRACE_MS\`,
\`AUTO_COMPACT_POLL_MS\`, \`AUTO_COMPACT_MIN_IDLE_MS\`.

### Configure panes (labels for orchestrator clarity)
\`\`\`bash
amux edit                            # open agentmux.yaml in \$EDITOR
amux label <agent> <pane> "purpose"
amux label <agent> <pane> --clear
amux labels                          # show all labels, tabulated
\`\`\`
Labels render in \`amux ps\` and \`amux top\` so an orchestrator can pick the right
pane without guessing.

### Wait for a pane to finish
\`\`\`bash
amux wait <agent> -p <pane>          # block until idle
amux wait <agent> -p 0 -t 600        # custom timeout (sec)
\`\`\`

### Pane is stuck or shows a modal
\`\`\`bash
amux esc <agent> -p <pane>           # send Escape (cancel/dismiss)
amux select <agent> -p <pane> <N>    # select menu option N
amux playwright-reap --dry           # inspect stale Playwright-MCP/browser processes
amux playwright-reap                 # reap stale Playwright-MCP/browser processes
\`\`\`

Bridge watchdog: stale Playwright-MCP/browser processes older than 60 min are
reaped automatically, and a pane stuck inside a Playwright MCP tool call for 10
min gets Escape. Visual proof is still expected when the user asks for it; the
watchdog exists so screenshots remain reliable, not so agents skip them.

### Bridge lifecycle
\`\`\`bash
amux serve                           # run bridge visibly here; Ctrl+C stops it
amux serve --detach                  # managed tmux-free bridge supervisor + watchdog
amux suggest                         # poll Suggestions visibly here; Ctrl+C stops polling
amux stop                            # stop bridge
amux stop --all                      # stop bridge + every agent session
\`\`\`

\`amux doctor\` sees foreground and detached bridges through PID + heartbeat;
the bridge does not need to live in tmux to be observable. Agents should not
silently replace a manual bridge with a daemon: use \`--detach\` only when the
user explicitly wants background ownership.

### Health check: FIRST stop when something seems silent or wrong
\`\`\`bash
amux doctor                          # bridge alive/hung/stale-code, hooks, ledger, tmux
\`\`\`
One table over every silent failure mode, each ⚠/❌ row comes with its fix.
Key row: "bridge code". The bridge is a long-lived process, so pushed amux
fixes are NOT live until it restarts (\`/restart\` in Discord). doctor flags
exactly that. A watchdog cron self-heals a hung bridge every 5 min and revives
a dead stack only in explicit \`--detach\` managed mode
(log: \`~/.agentmux/watchdog.log\`, kill-switch \`~/.agentmux/watchdog-OFF\`).

### Pane state is hook-pushed (event ledger)
Panes report their own working/idle/needs-you transitions via Claude Code
hooks to \`~/.agentmux/events.jsonl\`; \`ps\`/\`done\`/\`wait\`/auto-compact merge
that with tmux scraping (pushed events only refine idle/unknown, never
override a live modal). Permission asks + session starts show in
\`amux timeline\` as 🔔 rows; check those when investigating "what blocked
this pane while I was away". Slash commands sent from Discord (\`/model\` etc)
are delivery-verified: the reply says honestly whether the command was
consumed or still sits in the composer.

## Source layers

| Layer | What it sees | Use when |
|-------|--------------|----------|
| **jsonl** (\`amux log\`) | Structured turn history from \`~/.claude/projects/\` | "What did the agent say?" (default, reliable) |
| **tmux** (\`amux log --tmux\`) | Live terminal content | "Is the pane hung? Showing a modal?" |
| **ps/top** | Status indicator + context% | Quick overview |
| **timeline** | Merge of all jsonl, chronological | Cross-pane post-mortem |
| **done** | Commits + classified panes in a time window | Daily orchestration (use first) |
| **git log** | Via \`amux done\`, strongest work signal | Cross-repo "what shipped?" |

## Discord integration (when bridge is running)

- Every \`amux\` send to a pane **mirrors automatically** to the bound Discord
  channel. User sees your briefs live.
- Catch-up notice: when you post in Discord after a pause, the bridge shows
  how many turns happened in the pane without you, plus the 3 most-recent
  turn previews.
- Loop guard: if the user sends the same short message 3+ times in 30s, the
  bridge pauses forwarding and warns. Prevents runaway loops.

## Image replies

To attach an image to your Discord reply, write on its own line:

\`\`\`
[image: /absolute/path/to/file.png]
\`\`\`

Supported formats: .png, .jpg, .jpeg, .gif, .webp (max 25MB).

Alternative for tool/script flows (Bash steps, automation that can't use
the inline \`[image: ...]\` syntax): use the CLI directly.

\`\`\`bash
amux image /absolute/path/to/file.png
\`\`\`

Uploads the file to the bound Discord channel and prints the message ID.

### When to post images: non-negotiable

If the user asks for a screenshot, image, visual proof, "ge mig bilder",
"show me", "kan du visa", or any synonym: **post the file via
\`amux image <path>\` (or the inline \`[image: ...]\` syntax) immediately**.
Do not just save the file to disk and describe what's in it. The user
explicitly asked because they want to SEE.

Common failure mode: agent takes a screenshot via playwright/MCP, the
file lands in \`.playwright-mcp/\` or cwd, agent describes the contents
in text. User can't see it. Wasted turn.

Correct flow:

\`\`\`
playwright_take_screenshot → file at /path/to/foo.png
                            ↓
        amux image /path/to/foo.png   ← MUST happen
                            ↓
   Optional 1-line caption referencing the upload
\`\`\`

Even if the screenshot doesn't perfectly demonstrate what you wanted to
prove (e.g. browser auto-state changed, race window closed): POST IT
ANYWAY. Let the user see what you saw and decide if it's enough. Saying
"the screenshot didn't capture what I wanted" without posting it gives
the user nothing to evaluate.
`;
