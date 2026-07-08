// Agent interaction: send prompts, wait for responses, track progress.
// Manages tmux sessions directly. Single source of truth for claude startup + dismiss.

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { load as loadYaml } from "js-yaml";
import { esc, stripAnsi } from "./lib.mjs";
import { createTmuxAdapter } from "./core/tmux.mjs";
import { stripPaneChrome } from "./core/pane-chrome.mjs";
import { extractText, extractLastTurn, classifyLines, extractSegments, extractMixedStream, extractTurnByPrompt } from "./core/extract.mjs";
import { detectDialect, COMPOSER_LINE_RE, foreignComposerText } from "./core/dialects.mjs";
import { extractFromJsonl, isBusyFromJsonl, isPromptInJsonl } from "./core/jsonl-reader.mjs";
import { extractFromCodexJsonl, isBusyFromCodexJsonl, isPromptInCodexJsonl } from "./core/codex-jsonl-reader.mjs";
import { getContextPercent as getContextPercentByDialect, getContextFromPane } from "./core/context.mjs";
import { findBlockingPrompt } from "./core/dismiss.mjs";
import { startProgressTimer as createProgressTimer } from "./core/progress.mjs";
import { buildResumeHint } from "./core/resume-hint.mjs";

const CLAUDE_FLAGS = "--dangerously-skip-permissions";
const CODEX_FLAGS = "--dangerously-bypass-approvals-and-sandbox";

// --- Session isolation ---

/** All panes in .agents/N/ for full session isolation. */
export function paneDir(rootDir, pane) {
  const dir = join(rootDir, ".agents", String(pane));
  mkdirSync(dir, { recursive: true });
  ensureGitignored(rootDir, ".agents/");
  ensureAgentHints(rootDir);
  return dir;
}

// Placed in .agents/CLAUDE.md so Claude Code auto-reads it from any pane
// (panes run in .agents/N/, Claude searches upward for CLAUDE.md).
// Survives /compact because CLAUDE.md is system context, not conversation.
//
// The HINTS_VERSION marker lets ensureAgentHints detect stale copies on
// disk and overwrite them on next spawn — bump it whenever AGENT_HINTS
// content changes materially. User-appended content BELOW the end marker
// is preserved across upgrades.
const HINTS_VERSION = "1.20.38";
const HINTS_END_MARKER = "<!-- amux-hints-end -->";

const AGENT_HINTS = `<!-- amux-hints-version: ${HINTS_VERSION} -->
# agentmux

You are running inside agentmux. You can orchestrate other agents from your terminal.

**Never use raw \`tmux ... capture-pane\`.** Everything is exposed via \`amux\` —
shorter, validated, mirrors to Discord so the user sees what you do.

> Tip: \`ax\` is a shorter alias for \`amux\` (same script, both work). Use either.

## Cheat sheet (intent-first)

### Send a task to another pane
\`\`\`bash
amux <agent> -p <pane> "prompt"      # -p default 0
amux claw -p 1 "run the full test suite"
\`\`\`
Mirrors to Discord channel automatically (user sees your briefs). Auto-prepends
\`[from <sender-session>:<window>]\` when invoker is in tmux — receiver pane +
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

\`amux done\` is **pure time-window** — no state, no checkpoint, fully
idempotent. Call it as many times as you want; output is consistent.
Multiple agents can run it in parallel without races.

Output anatomy (same for all modes):

1. **\`▸ DU = <agent>:<pane>\`** — only when you run \`done\` from inside a pane.
   Your own state first: what you were last asked, your last reply, your status,
   and \`amux log\` for your full history. If you just lost context (compact /
   fresh spawn), this re-anchors you before anything else.
2. **\`Recent activity (top 20)\`** — last 20 events system-wide from a 7d
   window, independent of cutoff. 📝 commits + 🔸 pane activity, newest first.
   "Where were we" at a glance.
3. **Attention-first sections** — open loops over a WIDER window (old dropped
   balls surface), live state over the cutoff:
   - 📝 **Commits** — work shipped (strongest signal)
   - 🔴 **väntar på DITT svar / needs you** — agent asked the human a question,
     or a live modal. Ball is in the human's court.
   - ⚠️ **kanske tappad / maybe dropped** — the human's directive is the most
     recent message and the agent never replied + isn't live (idle >30min). This
     is the "I asked X, it never got done" detector.
   - 🟡 **jobbar / working** — live right now.
   - ✅ **klar / done** — replied within the window.
   - 💤 **idle** — counted.

   Each pane shows a 2-line **thread block** (age tag on actionable sections):
   \`\`\`
   claw:9   13:02  +164t  · 3h sen
      ← <last directives it received>     (≤3, oldest→newest; [from X] = inter-agent)
      → <its latest reply>
   \`\`\`
   The coordination payload: what a pane was told + where it landed, WITHOUT a
   follow-up \`amux log\`. Read a pane's ← line to see if it's already on your
   task. Sections cap at 8 rows (\`… +N\` → \`amux done --week\`).
4. **\`ℹ More:\`** footer — drill-down + send-to-pane + \`timeline --grep\` to find
   which pane you asked about something.

Use \`amux done\` at every decision point instead of 5× \`amux ps\` + per-pane
\`amux log\`: the feed gives "where was I", the thread blocks give "what is
everyone doing and what were they asked", 🔴/⚠️ give "what needs me / what got
dropped" — enough to coordinate, or to recover a dropped ball by handing it to
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
files are never matched — an active pane rewrites its jsonl continuously, so
its mtime is always seconds old. This only reaps abandoned/rotated sessions;
it does NOT and cannot shrink a live 100MB+ session (that's a \`/compact\` job —
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
amux serve                           # start Discord bridge
amux stop                            # stop bridge
amux stop --all                      # stop bridge + every agent session
\`\`\`

### Health check — FIRST stop when something seems silent or wrong
\`\`\`bash
amux doctor                          # bridge alive/hung/stale-code, hooks, ledger, tmux
\`\`\`
One table over every silent failure mode, each ⚠/❌ row comes with its fix.
Key row: "bridge code" — the bridge is a long-lived process, so pushed amux
fixes are NOT live until it restarts (\`/restart\` in Discord). doctor flags
exactly that. A watchdog cron self-heals a hung/dead bridge every 5 min
(log: \`~/.agentmux/watchdog.log\`, kill-switch \`~/.agentmux/watchdog-OFF\`).

### Pane state is hook-pushed (event ledger)
Panes report their own working/idle/needs-you transitions via Claude Code
hooks to \`~/.agentmux/events.jsonl\`; \`ps\`/\`done\`/\`wait\`/auto-compact merge
that with tmux scraping (pushed events only refine idle/unknown, never
override a live modal). Permission asks + session starts show in
\`amux timeline\` as 🔔 rows — check those when investigating "what blocked
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
| **done** | Commits + classified panes since last check | Daily orchestration (use first) |
| **git log** | Via \`amux done\` — strongest work signal | Cross-repo "what shipped?" |

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

### When to post images — non-negotiable

If the user asks for a screenshot, image, visual proof, "ge mig bilder",
"show me", "kan du visa", or any synonym — **post the file via
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
prove (e.g. browser auto-state changed, race window closed) — POST IT
ANYWAY. Let the user see what you saw and decide if it's enough. Saying
"the screenshot didn't capture what I wanted" without posting it gives
the user nothing to evaluate.

## Always lead with a recommendation

When presenting options or asking "what should we do?":

- **Don't** defer with "let me know which you prefer" / "up to you" / "whichever"
- **Do** pick one and give a one-line reason tied to the user's history/goals
- Template: \`→ Rekommenderar B. Varför: [specific tie-in]\`
- In doubt: still pick, then add "— säg till om du vill ha sanity check"

Drift-prone: the rule sits in system-context but attention weights tunnas
after many turns. The bridge's drift-guard sends you a \`[drift-guard]\`
reminder roughly every 40 turns (or after a /compact). When you get one,
re-read this section before responding.

Manual refresh: \`amux remind <agent> -p <pane>\` (or \`--all\` / \`--stale\`)
if you catch another pane drifting from this rule.

## Root cause > symptoms

Always fix the cause, not the symptom. Before patching, ask *why* it's happening.

- ❌ Test fails → skip the test
- ✅ Test fails → is the test wrong, or the code?
- ❌ Hook blocks commit → \`--no-verify\`
- ✅ Hook blocks → why? fix the underlying issue
- ❌ Error in prod → wrap in try/catch and swallow
- ✅ Error in prod → trace the path, fix the source

Quick workaround is OK when deliberate (time pressure, experiment) — but
**call it out**: "patching surface, root cause is X, fix later."

## Verify before reporting

Don't claim "done/exists/complete" until you've verified with 2+ methods.
Especially on WSL 9p mounts where \`Path.exists()\` can lie. Combine e.g.
\`ls | grep\` + \`Path.exists()\` + \`stat\`. If answers diverge: investigate.

## You share this repo with other agents

Multiple panes may be committing to the same repo in parallel, and so are
past-you (from prior sessions). Git log is the ledger of who did what —
treat it as your first source-of-truth when observing unexpected state.

Before claiming "bug/race/data-loss" on any state anomaly:

- \`git log --since="<timestamp>" --oneline\` FIRST. Intentional commits
  explain most "anomalies".
- 2 signals (timing + magnitude) does NOT prove causation. Test against
  git-timeline before hypothesizing.
- \`grep\` commit-messages for keywords from the observed change.

If a commit explains the anomaly → case closed, no bug. If no commit
explains it → then consider race / data-loss hypotheses.

Concrete pattern: a dedup commit landing between two deploys explains
a "video count drop" without any race condition. Skipped git log +
investigation spun up = noise to the user, wasted agent time.

## Multi-agent edit protocol

You and other agents may be editing the same repo in parallel. Three
rules to prevent silent regressions and version-bump collisions:

1. **Before editing a shared file:** \`git status\`. If there's WIP you
   didn't make → STOP. Run \`amux done\` + \`amux log <agent> -p N\` to
   identify the owner. Don't overwrite mid-flight refactors.
2. **Announce ownership for >5min edits:** \`amux <peer> -p N "claim
   handlers.mjs for X"\` so other panes see it in their channel. Cheap
   signal, prevents merge conflicts.
3. **Version bumps must be unique:** before \`package.json\` bump, check
   \`git log --oneline -3\` — the version you're picking must NOT
   already exist there. Same minor twice (e.g. two 1.16.2 commits)
   confuses downstream tooling.

Commit + push within 30 min of starting an edit. Long-running WIP that
isn't in git is invisible to other agents.

${HINTS_END_MARKER}
`;

// Write hints as both CLAUDE.md (for Claude Code) and AGENTS.md (for Codex).
// Both tools auto-read their respective file from cwd upward.
//
// Sync strategy:
//   - New files → write AGENT_HINTS as-is
//   - Existing files with matching HINTS_VERSION → leave alone (fresh)
//   - Existing files with older/missing version → replace everything up to
//     HINTS_END_MARKER, preserve any user-appended content below the marker
//
// This way upgrades propagate automatically on next spawn without clobbering
// workspace-specific notes that operators tacked on.
export function ensureAgentHints(rootDir) {
  const agentsDir = join(rootDir, ".agents");
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const path = join(agentsDir, name);
    try {
      if (!existsSync(path)) {
        writeFileSync(path, AGENT_HINTS);
        continue;
      }
      const current = readFileSync(path, "utf-8");
      const versionMatch = current.match(/<!-- amux-hints-version: ([^ ]+) -->/);
      if (versionMatch && versionMatch[1] === HINTS_VERSION) continue;

      // Preserve anything operators added after HINTS_END_MARKER.
      const endIdx = current.indexOf(HINTS_END_MARKER);
      const tail = endIdx >= 0 ? current.slice(endIdx + HINTS_END_MARKER.length) : "";
      writeFileSync(path, AGENT_HINTS + tail.replace(/^\s*\n/, "\n"));
    } catch (err) {
      console.warn(`agent hints write failed (${name}): ${err.message}`);
    }
  }
}

function ensureGitignored(rootDir, entry) {
  const gitignore = join(rootDir, ".gitignore");
  try {
    const content = existsSync(gitignore) ? readFileSync(gitignore, "utf-8") : "";
    if (!content.includes(entry)) {
      writeFileSync(gitignore, content.trimEnd() + "\n" + entry + "\n");
    }
  } catch (err) {
    console.warn(`gitignore update failed: ${err.message}`);
  }
}

// --- Agent factory ---

export function createAgent({ tmuxSocket, configPath, timeout, delay, run, tmuxExec, onResumeHint }) {
  const wait = delay || ((ms) => new Promise((r) => setTimeout(r, ms)));
  // All tmux syntax lives in the adapter (core/tmux.mjs). agent.mjs speaks
  // intent-level primitives; escaping is the adapter's tested concern.
  const t = createTmuxAdapter({ socket: tmuxSocket, exec: tmuxExec });

  // --- Config ---

  function loadConfig() {
    try { return loadYaml(readFileSync(configPath, "utf-8")) || {}; }
    catch { return {}; }
  }

  function agentConfig(name) {
    const config = loadConfig();
    if (!config[name]?.dir) throw new Error(`Agent '${name}' not found in ${configPath}`);
    return config[name];
  }

  // --- tmux primitives ---

  async function hasSession(name) {
    return t.hasSession(name);
  }

  // Strip Claude-session identity vars from tmux's global environment.
  // If the tmux SERVER was started from inside a Claude Code session (e.g.
  // `amux serve` run by an agent's Bash tool), every new pane inherits
  // CLAUDECODE/CLAUDE_CODE_CHILD_SESSION/CLAUDE_CODE_SESSION_ID — and any
  // claude launched there believes it's a child of that session and SILENTLY
  // STOPS PERSISTING its transcript jsonl (2026-06-11 incident: no Discord
  // mirroring, invisible replies across all agents after a reboot recovery).
  async function sanitizeTmuxGlobalEnv() {
    let names = [];
    try {
      names = (await t.globalEnvNames())
        .filter((n) => /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_EFFORT$|AI_AGENT$)/.test(n));
    } catch (err) {
      console.warn(`sanitizeTmuxGlobalEnv: show-environment failed: ${err.message}`);
      return;
    }
    // Independent unsets: run them concurrently (tmux serializes server-side).
    await Promise.all(names.map((n) =>
      t.unsetGlobalEnv(n).catch((err) =>
        console.warn(`sanitizeTmuxGlobalEnv: unset ${n} failed: ${err.message}`))));
  }

  async function ensureSession(name) {
    await sanitizeTmuxGlobalEnv();
    if (await hasSession(name)) return;
    await t.newSession(name);
    await t.sourceUserConf().catch((err) =>
      console.warn(`tmux: source-file .tmux.conf failed: ${err.message}`));
    // Let tmux handle window sizing naturally. We used to force a minimum
    // window width to prevent Claude's bottom bar from truncating
    // "esc to interrupt", but busy-signal detection now matches the
    // truncated form "esc to interrup" directly (see dialects.mjs), so
    // the width-forcing was both useless (narrow panes still truncated)
    // and harmful (fought the attached client's terminal geometry).
  }

  async function exitCopyMode(target) {
    try {
      if (await t.paneInMode(target)) {
        // -X cancel (inside the adapter) exits copy/view/choose mode without
        // forwarding any keystroke: race-free vs a raw `q` that could leak
        // into Claude's input box, and independent of mode-keys bindings.
        await t.cancelCopyMode(target);
        await wait(300);
      }
    } catch (err) {
      // Target pane may not exist yet, expected during startup. Log only
      // if this looks unexpected (anything other than "no such pane").
      if (!/no such/.test(err.message || "")) {
        console.warn(`exitCopyMode(${target}) failed: ${err.message}`);
      }
    }
  }

  // --- Pane setup ---

  // Make room before split-window. Detached windows default to 80x24 and a
  // partial tmux-resurrect restore can leave 1-column "sliver" panes; either
  // makes `split-window` fail with "no space for new pane". Force a roomy
  // manual size so splits always fit. Pair with restoreAutoSize() so an
  // attaching client still drives the geometry afterwards.
  async function ensureSplitRoom(name) {
    await t.setWindowSizeManual(name).catch(() => {});
    await t.resizeWindow(name, 240, 60).catch(() => {});
  }

  async function restoreAutoSize(name) {
    await t.setWindowSizeLatest(name).catch(() => {});
  }

  async function setupPanes(name, dir) {
    const config = loadConfig();
    const panes = config[name]?.panes || [];
    if (!panes.length) return;

    const layout = config[name]?.layout || "main-vertical";
    const applyLayout = async () => {
      await t.selectLayout(name, layout).catch((err) =>
        console.warn(`setupPanes: select-layout ${layout} failed: ${err.message}`));
    };

    // Guarantee room + reflow any sliver panes before the first split.
    await ensureSplitRoom(name);
    await applyLayout();
    const existing = await countPanes(name);
    for (let i = existing; i < panes.length; i++) {
      // -c pins the new pane's cwd to its own .agents/N. Without it,
      // tmux inherits cwd from whichever pane is active at split-time —
      // unpredictable after select-layout, and the cause of the
      // pane-N-writes-jsonl-to-agents-M bug that broke Discord channel
      // mapping. paneDir mkdir:s the dir so -c can't fail on it missing.
      const targetDir = paneDir(dir, i);
      const splitTarget = `${name}:.${i - 1}`;
      try {
        await t.splitWindowRight(splitTarget, targetDir);
        await applyLayout();
      } catch (err) {
        console.warn(`setupPanes: split-window ${name} failed: ${err.message}`);
        break;
      }
    }

    await applyLayout();

    const actualPanes = await countPanes(name);
    if (actualPanes < panes.length) {
      console.warn(`setupPanes: ${name} has ${actualPanes}/${panes.length} panes after split; skipping missing panes`);
    }

    for (let i = 0; i < Math.min(panes.length, actualPanes); i++) {
      const target = `${name}:.${i}`;
      if (await isAlreadyRunning(target)) continue;

      if (isAgentCmd(panes[i].cmd)) {
        // Claude/codex panes: skip entirely. startClaude/startCodex (via
        // ensureReady) does cd + start + dismiss when the pane is first
        // used. This avoids burning the agent's first turn on startup
        // before any user prompt arrives.
        continue;
      } else if (panes[i].defer) {
        await t.runShell(target, `cd ${esc(dir)}`);
      } else {
        await t.runShell(target, `cd ${esc(dir)} && ${panes[i].cmd}`);
      }
      await wait(500);
    }
    await t.selectPane(`${name}:.0`).catch((err) =>
      console.warn(`setupPanes: select-pane 0 failed: ${err.message}`));
    await restoreAutoSize(name);
  }

  async function countPanes(name) {
    try {
      return await t.paneCount(name);
    } catch (err) {
      // Session may not exist yet, treat as 1 default pane
      return 1;
    }
  }

  async function paneCountAfterReconcile(name, wantedCount) {
    const actual = await countPanes(name);
    if (actual < wantedCount) {
      console.warn(`reconcile: ${name} has ${actual}/${wantedCount} panes after split; skipping missing panes`);
    }
    return actual;
  }

  async function isAlreadyRunning(target) {
    try {
      const cmd = await t.currentCommand(target);
      // Pane is "free" only if a shell is at the prompt. Anything else
      // (claude, rclone, ssh, vim, tail, ...) means a process owns the
      // pane — don't send-keys into it, they'd land as stdin to that process.
      return !/^(bash|zsh|fish|sh|dash)$/.test(cmd);
    } catch {
      // Target doesn't exist → not running
      return false;
    }
  }

  function isClaudeCmd(cmd) {
    return cmd?.includes("claude") || false;
  }

  function isCodexCmd(cmd) {
    return cmd?.includes("codex") || false;
  }

  function isAgentCmd(cmd) {
    return isClaudeCmd(cmd) || isCodexCmd(cmd);
  }

  function isShellProc(cmd) {
    return /^(bash|zsh|fish|sh|dash)$/.test(cmd);
  }

  // True when a pane's current process matches the type expected by config.
  // Both claude and codex CLIs are node-based, so the live process name is
  // typically the binary name or "node". Services are matched loosely: any
  // non-shell, non-agent process is assumed to be the configured service.
  function paneTypeMatches(currCmd, wantCmd) {
    if (isClaudeCmd(wantCmd)) return /^(claude|node)$/.test(currCmd);
    if (isCodexCmd(wantCmd)) return /^(codex|node)$/.test(currCmd);
    if (wantCmd === "bash") return isShellProc(currCmd);
    return !isShellProc(currCmd) && !/^(claude|codex|node)$/.test(currCmd);
  }

  // --- Reconciliation ---

  /**
   * Align a live tmux session with its config: add missing panes, respawn panes
   * whose current process doesn't match the configured command type. Leaves
   * correctly-matching panes untouched (preserves running claude/service state).
   *
   * Claude panes that get respawned are left as idle shells; startClaude runs
   * on demand next time the pane is used.
   */
  async function reconcileSession(name) {
    const config = loadConfig();
    const cfg = config[name];
    if (!cfg?.panes?.length) return { skipped: true, reason: "no config" };
    if (!(await hasSession(name))) return { skipped: true, reason: "no session" };

    const summary = { name, added: 0, respawned: [], unchanged: 0, extras: 0 };
    const wanted = cfg.panes;
    const layout = cfg.layout || "main-vertical";
    const applyLayout = async () => {
      await t.selectLayout(name, layout).catch((err) =>
        console.warn(`reconcile: select-layout ${layout} failed: ${err.message}`));
    };

    // Guarantee room + reflow any sliver panes before the first split, else
    // a bad restore (80x24 window / 1-col pane) fails with "no space".
    const needsPanes = (await countPanes(name)) < wanted.length;
    if (needsPanes) {
      await ensureSplitRoom(name);
      await applyLayout();
    }

    const currentCount = await countPanes(name);
    for (let i = currentCount; i < wanted.length; i++) {
      try {
        // See setupPanes for why -c is mandatory. Same bug, same fix.
        const targetDir = paneDir(cfg.dir, i);
        const splitTarget = `${name}:.${i - 1}`;
        await t.splitWindowRight(splitTarget, targetDir);
        summary.added++;
        await applyLayout();
      } catch (err) {
        console.warn(`reconcile: split-window ${name} failed: ${err.message}`);
        break;
      }
    }
    if (summary.added > 0) {
      await applyLayout();
    }
    const actualCount = await paneCountAfterReconcile(name, wanted.length);
    if (actualCount > wanted.length) summary.extras = actualCount - wanted.length;
    if (actualCount < wanted.length) summary.missing = wanted.length - actualCount;

    for (let i = 0; i < Math.min(wanted.length, actualCount); i++) {
      const target = `${name}:.${i}`;
      const want = wanted[i];
      let currCmd = "";
      try {
        currCmd = await t.currentCommand(target);
      } catch { continue; }

      if (paneTypeMatches(currCmd, want.cmd)) { summary.unchanged++; continue; }

      // Safety: never respawn a pane that's running claude or codex, even
      // if config says something else. User may have active work there;
      // forcing a slot into a shell would destroy context. Report as a
      // mismatch instead.
      if (/^(claude|codex|node)$/.test(currCmd)) {
        summary.mismatches = summary.mismatches || [];
        summary.mismatches.push({ pane: i, has: currCmd, expected: want.name });
        continue;
      }

      // Only respawn panes where the current process is a shell (idle) or a
      // clearly non-interactive process (tail, rclone, etc). This is what
      // fixes the original bug: pane has `tail` but config wants claude.
      // -c uses paneDir(cfg.dir, i) so the respawned shell lands in the
      // pane's own .agents/N — same fix-rationale as the split-window
      // calls above; sourcing cwd from cfg.dir alone caused panes 4..N
      // to share the agent root and write claude jsonl to the wrong
      // project hash.
      const respawnDir = paneDir(cfg.dir, i);
      try {
        if (isAgentCmd(want.cmd) || want.cmd === "bash") {
          // Leave as shell; startClaude/startCodex runs on demand when
          // pane is used.
          await t.respawnPane(target, { kill: true, cwd: respawnDir });
        } else {
          // Services must mirror setupPanes: shell pane + send-keys
          // 'cd <root> && cmd'. Services run from the repo root (that's
          // where Makefile/package.json live), not .agents/N. And the
          // command must run INSIDE a shell — with respawn-pane '<cmd>'
          // the command IS the pane process, so a service that exits
          // immediately closes the pane, renumbers the rest, and makes
          // every later respawn target miss ("can't find pane: N").
          await t.respawnPane(target, { kill: true, cwd: cfg.dir });
          await t.runShell(target, `cd ${esc(cfg.dir)} && ${want.cmd}`);
        }
        summary.respawned.push({ pane: i, was: currCmd, expected: want.name });
      } catch (err) {
        console.warn(`reconcile: respawn ${target} failed: ${err.message}`);
      }
    }

    if (needsPanes) await restoreAutoSize(name);
    return summary;
  }

  // --- Claude lifecycle ---

  async function startClaude(name, target, rootDir, pane = 0) {
    if (await isPaneDead(target)) await respawnPane(target);
    if (await isAlreadyRunning(target)) return;

    const dir = paneDir(rootDir, pane);
    const sessionFlag = resolveSessionFlag(dir);
    await t.runShell(target, `cd ${esc(dir)} && ANTHROPIC_DISABLE_SURVEY=1 claude ${CLAUDE_FLAGS} ${sessionFlag}`);
    await wait(2000);
  }

  async function startCodex(name, target, rootDir, pane = 0) {
    if (await isPaneDead(target)) await respawnPane(target);
    if (await isAlreadyRunning(target)) return;

    const dir = paneDir(rootDir, pane);
    // Try `codex resume --last` first to pick up the most recent session
    // for this pane's cwd; fall back to fresh `codex` when no prior
    // session exists (first launch). Both inherit cwd from the cd above
    // so codex jsonl lands in .agents/N/ — same isolation as claude.
    const cmd = `codex resume --last ${CODEX_FLAGS} 2>/dev/null || codex ${CODEX_FLAGS}`;
    await t.runShell(target, `cd ${esc(dir)} && ${cmd}`);
    await wait(2000);
  }

  async function isPaneDead(target) {
    try {
      return await t.paneDead(target);
    } catch {
      // Target doesn't exist → not dead (doesn't exist yet)
      return false;
    }
  }

  async function respawnPane(target) {
    // Record the old pid so we can confirm the new shell forked. Without
    // this, the 500ms hard-wait was either wasteful (shell ready in 50ms)
    // or insufficient (tmux hadn't finished respawning yet), and the
    // subsequent `cd && claude` send-keys could go to a pty that hadn't
    // been wired to a readline loop yet.
    let oldPid = "";
    try {
      oldPid = await t.panePid(target);
    } catch {
      // pane may not exist yet or be fully dead, treat as unknown pid
    }

    try {
      await t.respawnPane(target, { kill: true });
    } catch (err) {
      console.warn(`respawnPane(${target}) failed: ${err.message}`);
      return;
    }

    // Poll for a new shell pid to appear. Tmux send-keys buffers to the
    // pty even before readline is active, so as long as the fork happened
    // we're safe to start sending commands. .bashrc will consume them
    // once it finishes initializing.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const [newPid, cmd] = await Promise.all([
          t.panePid(target),
          t.currentCommand(target),
        ]);
        if (newPid && newPid !== oldPid && /^(bash|zsh|sh|fish|dash)$/.test(cmd)) return;
      } catch {
        // keep polling
      }
      await wait(100);
    }
    console.warn(`respawnPane(${target}) timed out waiting for new shell`);
  }

  /** --continue if session exists, otherwise no flag (new session). */
  function resolveSessionFlag(dir) {
    // Claude Code encodes project dirs by replacing both / and . with -
    const encodedDir = dir.replace(/[\/\.]/g, "-");
    const projectDir = join(process.env.HOME, ".claude", "projects", encodedDir);
    try {
      if (readdirSync(projectDir).some((f) => f.endsWith(".jsonl"))) return "--continue";
    } catch {}
    return "";
  }

  /** Wait for claude to load, dismiss any blocking prompts if they appear. */
  async function waitForClaudeReady(target, agentName, pane) {
    // Wait for claude process to appear
    for (let i = 0; i < 15; i++) {
      if (await isAlreadyRunning(target)) break;
      await wait(500);
    }

    // Poll for resume/dismiss or idle (old sessions may prompt)
    for (let j = 0; j < 8; j++) {
      await wait(1000);
      const dismissed = await dismissBlockingPrompt(target);
      if (dismissed) return;
      if (!(await isBusy(agentName, pane))) return;
    }
  }

  // --- Dismiss ---

  async function dismissBlockingPrompt(target) {
    let paneText;
    try {
      paneText = await t.capture(target, { lines: 20 });
    } catch (err) {
      console.warn(`dismiss: capture failed for ${target}: ${err.message}`);
      return null;
    }

    const prompt = findBlockingPrompt(paneText);
    if (!prompt) return null;

    await t.sendKeys(target, prompt.keys);
    await wait(prompt.waitMs);
    return prompt.name;
  }

  // --- Query ---

  async function getResponse(agentName, pane) {
    const raw = await capturePane(agentName, pane, 5000);
    return extractText(raw) || "(empty response)";
  }

  /** Derive which agent dialect a pane runs from its configured cmd. */
  function paneDialectName(agentName, pane) {
    try {
      const config = agentConfig(agentName);
      const cmd = config.panes?.[pane]?.cmd || "";
      if (cmd.includes("codex")) return "codex";
      if (cmd.includes("claude")) return "claude";
      return null;
    } catch (err) {
      console.warn(`paneDialectName(${agentName}) failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Derive dialect from the live pane when config is stale.
   *
   * Some long-running panes can be repurposed without agents.yaml changing
   * first. Example: ai:p3 is configured as a service pane, but currently runs
   * Codex (node). Config-only dialect detection then misses Codex-specific
   * echo checks and send quirks. Keep this as a fallback so configured Claude
   * panes remain fast and deterministic.
   */
  async function livePaneDialectName(agentName, pane) {
    const configured = paneDialectName(agentName, pane);
    if (configured) return configured;

    const target = `${agentName}:.${pane}`;
    try {
      if ((await t.currentCommand(target)) !== "node") return null;

      const raw = await capturePane(agentName, pane, 120);
      const dialect = detectDialect(raw);
      return dialect?.name || null;
    } catch (err) {
      console.warn(`livePaneDialectName(${agentName}:${pane}) failed: ${err.message}`);
      return null;
    }
  }

  async function isBusy(agentName, pane, promptText = null) {
    // Source of truth: read the agent's own session file instead of parsing
    // tmux rendering. Dispatch on the pane's configured cmd so we don't
    // cross-read another agent's jsonl (cdx and claw can share pane dirs).
    try {
      const config = agentConfig(agentName);
      const dir = paneDir(config.dir, pane);
      const dialect = paneDialectName(agentName, pane);

      if (dialect === "codex") {
        const r = isBusyFromCodexJsonl(dir);
        if (r !== null) return r;
      } else if (dialect === "claude") {
        const r = isBusyFromJsonl(dir, promptText);
        if (r !== null) return r;
        // jsonl exists but our prompt isn't there yet. Claude hasn't
        // written it. Assume busy so we keep polling. workMaxMs is the
        // safety escape if this never resolves.
        return true;
      }
    } catch (err) {
      console.warn(`isBusy(${agentName}) dispatch failed, falling back to tmux: ${err.message}`);
    }

    // Fallback: tmux parsing (Codex, missing jsonl, no matching prompt yet)
    const raw = await capturePane(agentName, pane, 20);
    const dialect = detectDialect(raw);

    // Dialect-specific busy signals. Each entry can be a string (substring
    // match) or a RegExp (pattern match). Supports both literal indicators
    // like "esc to interrup" and shape-matchers like /\w+ing…\s*\(/ for
    // thinking verbs (Musing…, Orchestrating…, Doing…).
    const hit = dialect.busySignals?.some((sig) =>
      typeof sig === "string" ? raw.includes(sig) : sig.test(raw),
    );
    if (hit) return true;

    // Dialects that always show a placeholder in their prompt (e.g. Codex)
    // can't use prompt-has-text as a busy signal. Rely on busySignals only.
    if (!dialect.idleWhenPromptEmpty) return false;

    // Dialects with an empty prompt when idle (e.g. Claude Code)
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    const tail = lines.slice(-10);
    const promptLine = tail.findLast((l) => l.startsWith(dialect.promptChar));
    if (!promptLine) return true;
    return promptLine.slice(dialect.promptChar.length).trim().length > 0;
  }

  async function getResponseSegments(agentName, pane) {
    const raw = await capturePane(agentName, pane, 5000);
    return extractSegments(classifyLines(extractLastTurn(raw)));
  }

  /** Get text + tool calls in order. If promptText given, finds that exact turn. */
  async function getResponseStream(agentName, pane, promptText = null) {
    const { items } = await getResponseStreamWithRaw(agentName, pane, promptText);
    return items;
  }

  /**
   * Same as getResponseStream but also returns raw buffer + turn slice (for recording).
   *
   * Source-of-truth strategy:
   *   1. Prefer Claude's jsonl session file. It has exact text with code fences,
   *      structured tool_use blocks, and no UI rendering artifacts. This eliminates
   *      narrow-pane wordwrap, progress-icon interference, code-block destruction, etc.
   *   2. Fall back to tmux extract if jsonl is missing (Codex or fresh session)
   *      or contains no matching turn (e.g. echo confirmed but claude crashed
   *      before writing the response).
   */
  async function getResponseStreamWithRaw(agentName, pane, promptText = null) {
    const config = agentConfig(agentName);
    const dir = paneDir(config.dir, pane);
    const dialect = paneDialectName(agentName, pane);

    // Dispatch to the pane's actual dialect, not trial-and-error. Otherwise
    // cdx and claw (which can share pane dirs like .agents/0/) would read
    // each other's jsonl files.
    if (dialect === "codex") {
      const codex = extractFromCodexJsonl(dir, promptText);
      if (codex && codex.items.length > 0) return codex;
    } else if (dialect === "claude") {
      const claude = extractFromJsonl(dir, promptText);
      if (claude && claude.items.length > 0) return claude;
    }

    // Last-resort fallback: tmux parsing.
    const raw = await capturePane(agentName, pane, 5000);
    const turn = promptText ? extractTurnByPrompt(raw, promptText) : extractLastTurn(raw);
    const items = extractMixedStream(classifyLines(turn));

    // Quality gate: when the last turn is mostly pane-chrome (input box,
    // spinner glyphs, progress bars, model+context footer) the extractor
    // happily returns it as "text". Discord ends up showing block characters
    // and Claude UI elements as if they were the agent's reply. Strip those
    // first; if nothing meaningful survives, return empty rather than ship
    // junk. Better silence than gibberish.
    const cleaned = items.map((it) =>
      it.type === "text" ? { ...it, content: stripPaneChromeForFallback(it.content) } : it,
    ).filter((it) => it.type !== "text" || it.content.trim().length > 0);

    if (items.length > 0 && cleaned.length === 0) {
      console.warn(`[${agentName}:${pane}] tmux fallback rejected — all items were pane-chrome`);
      return { raw, turn, items: [], source: "tmux-rejected" };
    }
    return { raw, turn, items: cleaned, source: "tmux" };
  }

  // Pane-chrome stripping is shared (core/pane-chrome.mjs) so a chrome
  // pattern learned once (e.g. the fable footer) protects the tmux
  // fallback, the voice route and any future consumer at the same time.
  const stripPaneChromeForFallback = stripPaneChrome;

  /**
   * True when the source-of-truth session store already contains response
   * items for this exact prompt. No tmux fallback here, we only want a
   * positive signal from structured data.
   */
  function hasResponseForPrompt(agentName, pane, promptText) {
    const needle = promptText?.trim();
    if (!needle) return false;

    const config = agentConfig(agentName);
    const dir = paneDir(config.dir, pane);
    const dialect = paneDialectName(agentName, pane);

    if (dialect === "codex") {
      const codex = extractFromCodexJsonl(dir, promptText);
      return Boolean(codex?.items?.length);
    }
    if (dialect === "claude") {
      const claude = extractFromJsonl(dir, promptText);
      return Boolean(claude?.items?.length);
    }
    return false;
  }

  async function capturePane(agentName, pane, lines = 50) {
    // join=true (-J) merges wrapped lines into single logical lines. Without
    // it, narrow panes (e.g. 42-col panes in main-vertical layouts) split the
    // prompt and response across multiple lines, confusing extract which
    // treats continuation lines as new text segments.
    const stdout = await t.capture(`${agentName}:.${pane}`, { lines });
    return stripAnsi(stdout).trimEnd() || "(empty)";
  }

  /**
   * Poll the pane until the user's prompt text appears in the buffer,
   * confirming the agent has actually received the input.
   *
   * Source of truth: the agent's own session jsonl. When the user prompt
   * appears there, we know for certain the agent received it. No tmux
   * pane width tricks, no wordwrap to fight. Falls back to tmux text
   * matching when no jsonl is available.
   *
   * @returns true if echo seen, false on timeout
   */
  async function waitForPromptEcho(agentName, pane, promptText, timeoutMs = 15000) {
    const needle = promptText?.trim();
    if (!needle) return true;

    const dir = paneDir(agentConfig(agentName).dir, pane);
    const dialect = paneDialectName(agentName, pane);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Try jsonl first (width-independent, reliable)
      let found = null;
      if (dialect === "claude") found = isPromptInJsonl(dir, promptText);
      else if (dialect === "codex") found = isPromptInCodexJsonl(dir, promptText);
      if (found === true) return true;

      // jsonl hasn't positively confirmed — found === false means the agent
      // hasn't written the prompt yet; found === null means unknown dialect
      // or no jsonl. The keystrokes may sit in the composer, but that is
      // only DELIVERY when a turn is running (a queued message auto-submits
      // at turn end, which can take minutes — don't hold the send-lock for
      // that). On an IDLE pane, text in the composer is UNSUBMITTED: calling
      // it delivered here is exactly how a prompt got lost on 2026-07-08
      // (claude restarted under a 547MB jsonl and dropped the composer)
      // while the bridge logged 'delivered' and no ⚠️ ever reached Discord.
      // Idle+in-composer keeps polling: the submit-rescue may land it in
      // jsonl (→ true), else we time out (→ false) and the caller's retry/
      // warning path finally tells the human the truth.
      if (found !== true) {
        const raw = await capturePane(agentName, pane, 100);
        const tail = raw.split("\n").slice(-15).join("\n");
        if (tail.includes(needle.slice(0, 20))) {
          const dialect2 = detectDialect(raw);
          const busyHit = dialect2.busySignals?.some((sig) =>
            typeof sig === "string" ? raw.includes(sig) : sig.test(raw));
          if (busyHit) return true; // queued behind a live turn: delivered
        }
      }

      await wait(200);
    }
    return false;
  }

  // --- Send ---

  async function sendPrompt(agentName, prompt, pane) {
    const target = `${agentName}:.${pane}`;
    await exitCopyMode(target);

    // Idempotent retries: if a previous attempt left this exact prompt
    // sitting unsubmitted in the composer, typing it again would double the
    // text. Skip straight to the submit path instead.
    if (!(await promptAlreadyInComposer(agentName, pane, prompt))) {
      await clearForeignComposerText(agentName, pane, target, prompt);
      if (prompt.length > 500) {
        await sendLongPrompt(target, prompt);
      } else {
        await t.sendLiteral(target, prompt);
        await wait(1000);
      }
    }
    await t.sendEnter(target);
    await maybeSendCodexSubmitEnter(agentName, pane, target, prompt);
    await maybeRescueClaudeSubmit(agentName, pane, target, prompt);
  }

  async function promptAlreadyInComposer(agentName, pane, prompt) {
    const head = prompt.trim().slice(0, 20);
    if (!head) return false;
    try {
      const raw = await capturePane(agentName, pane, 15);
      // Composer lines render as "❯ text" (claude) / "› text" (codex) /
      // "> text" (legacy). COMPOSER_LINE_RE is built from dialect data —
      // a hardcoded [❯>] here missed codex's "›", so retries re-typed a
      // brief that was already sitting in the composer (ai:4 2026-07-08).
      // Requiring the marker keeps a prompt-head quoted in SCROLLBACK from
      // suppressing a legitimate first type-in.
      return raw.split("\n").slice(-5).some((l) => {
        const line = l.trim();
        return COMPOSER_LINE_RE.test(line) && line.includes(head);
      });
    } catch {
      return false;
    }
  }

  /**
   * A previous failed delivery can leave ITS text sitting in the composer.
   * Typing on top of it corrupts both messages, and the NEXT send then
   * submits the merged garbage (ai:4 2026-07-08: a brief typed into an
   * interrupted codex TUI never submitted; 13 minutes later it went out as
   * "][ai:2, …"). Clear foreign text before typing — but only when the pane
   * is not mid-turn: on a busy pane composer text is a legitimately QUEUED
   * message (and Esc would interrupt the live turn), so we leave it alone
   * and let our text queue behind it.
   */
  async function clearForeignComposerText(agentName, pane, target, prompt) {
    let raw;
    try { raw = await capturePane(agentName, pane, 15); } catch { return; }
    const head = prompt.trim().slice(0, 20);
    const stale = foreignComposerText(raw, head);
    if (!stale) return;
    if (await isBusy(agentName, pane)) return;
    console.warn(
      `send ${agentName}:${pane}: clearing stale composer text ("${stale.slice(0, 40)}…") — a previous delivery never submitted`,
    );
    await t.sendEscape(target); // Esc with text in the composer clears it (both TUIs)
    await wait(300);
    const after = await capturePane(agentName, pane, 15).catch(() => "");
    if (foreignComposerText(after, head)) {
      await t.sendKeys(target, "C-u"); // belt: kill-line for TUIs that keep text on Esc
      await wait(200);
    }
  }

  async function maybeSendCodexSubmitEnter(agentName, pane, target, prompt) {
    const dialect = await livePaneDialectName(agentName, pane);
    if (dialect !== "codex") return;

    // Codex's node CLI accepts a tmux paste into the composer but routinely
    // misses the immediate Enter for long pasted prompts: the paste is still
    // rendering when our `send-keys Enter` arrives, and the keystroke gets
    // absorbed into the composer instead of submitting. A single rescue Enter
    // 750ms later isn't always enough on slower systems / very long prompts —
    // both the initial Enter and the rescue can be eaten.
    //
    // Strategy: poll the rollout jsonl (codex writes user_message there on
    // submit). If the prompt isn't recorded after a wait, send another Enter
    // and re-check. Cap retries so a stuck pane can't loop. jsonl is source
    // of truth — message only lands once Codex has actually submitted.
    let dir;
    try { dir = paneDir(agentConfig(agentName).dir, pane); } catch { dir = null; }

    const submitted = async () => {
      if (!dir) return null;            // unknown — caller falls back to retry
      try { return isPromptInCodexJsonl(dir, prompt) === true; }
      catch { return null; }
    };

    // First check: was the original Enter from sendPrompt enough?
    await wait(750);
    if (await submitted() === true) return;

    // Up to 3 rescue attempts, spaced 750ms. Stops as soon as jsonl confirms.
    for (let attempt = 0; attempt < 3; attempt++) {
      await t.sendEnter(target);
      await wait(750);
      if (await submitted() === true) return;
    }
  }

  /**
   * Claude twin of the codex submit-rescue. A long paste + immediate Enter
   * can leave the text SITTING in the composer of an idle pane (paste still
   * rendering when Enter lands, or claude restarting under a huge session
   * jsonl — observed 2026-07-08: prompt pasted, echo-verified via composer
   * tail, then lost). Composer text on a BUSY pane is a legitimately queued
   * message and is left alone; only idle+still-in-composer gets rescued.
   * jsonl is the source of truth for "actually submitted".
   */
  async function maybeRescueClaudeSubmit(agentName, pane, target, prompt) {
    if (paneDialectName(agentName, pane) !== "claude") return;
    let dir;
    try { dir = paneDir(agentConfig(agentName).dir, pane); } catch { return; }

    const submitted = () => {
      try { return isPromptInJsonl(dir, prompt) === true; } catch { return false; }
    };

    await wait(750);
    if (submitted()) return;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (await isBusy(agentName, pane)) return;       // queued behind a turn: fine
      const raw = await capturePane(agentName, pane, 15).catch(() => "");
      const tail = raw.split("\n").slice(-5).join("\n");
      if (!tail.includes(prompt.trim().slice(0, 20))) return; // not in composer
      await t.sendEnter(target);
      await wait(750);
      if (submitted()) return;
    }
  }

  async function sendLongPrompt(target, prompt) {
    const tmpFile = `/tmp/agentmux-prompt-${process.pid}.txt`;
    const bufName = `prompt_${process.pid}_${Date.now()}`;
    writeFileSync(tmpFile, prompt);
    await t.loadBuffer(bufName, tmpFile);
    await t.pasteBuffer(bufName, target);
    try { unlinkSync(tmpFile); } catch (err) {
      console.warn(`sendLongPrompt: cleanup ${tmpFile} failed: ${err.message}`);
    }
    // paste-buffer returns after tmux has queued the paste. Keep this short:
    // callers often wrap amux sends in a timeout, and a long pre-Enter sleep
    // leaves the prompt pasted but not submitted if the wrapper kills us.
    await wait(250);
  }

  // --- Orchestration ---

  async function ensureReady(agentName, pane) {
    const config = agentConfig(agentName);
    const isNew = !(await hasSession(agentName));

    await ensureSession(agentName);
    if (isNew) {
      await setupPanes(agentName, config.dir);
      await wait(2000);
    } else if ((await countPanes(agentName)) < (config.panes?.length || 0)) {
      // Session exists but is under-provisioned — e.g. a partial
      // tmux-resurrect restore left 2/8 panes. Rebuild the missing panes so a
      // plain `amux <agent>` self-heals the layout instead of just warning and
      // attaching. reconcileSession never respawns live claude/codex panes, so
      // running work is safe.
      await reconcileSession(agentName);
      await wait(1000);
    }

    const target = `${agentName}:.${pane}`;
    const paneCmd = config.panes?.[pane]?.cmd || "bash";

    if (isClaudeCmd(paneCmd)) {
      // Track whether we're spawning claude on this call so we can inject
      // the resume-hint after-spawn (instead of waiting for first amux brief).
      // Without this, panes that user opens directly via `amux <agent>` attach
      // and types into themselves never see the hint — the hint only ever
      // fired through sendOnly/sendAndWait briefs prior to 1.14.0.
      const wasStarting = !(await isAlreadyRunning(target));
      await startClaude(agentName, target, config.dir, pane);
      await waitForClaudeReady(target, agentName, pane);
      if (wasStarting) await injectResumeHint(agentName, pane, config.dir);
    } else if (isCodexCmd(paneCmd)) {
      // Codex panes use the same wait-for-ready + dismiss pattern as
      // claude (both are interactive node-based CLIs that may surface
      // a resume-prompt on cold start). Resume-hint is skipped because
      // codex auto-resumes via `codex resume --last` in startCodex.
      await startCodex(agentName, target, config.dir, pane);
      await waitForClaudeReady(target, agentName, pane);
    }
  }

  /**
   * Send the resume-hint as the first user-prompt to a freshly-spawned
   * claude pane. Lets empty-state panes find their previous jsonl without
   * needing an orchestrator brief to trigger the prepend path. Idempotent
   * for full-context panes (they recognize the snippet and absorb it).
   *
   * Failure here is not a correctness issue — agents can still operate
   * without the hint, just less self-aware about prior session state.
   */
  async function injectResumeHint(agentName, pane, rootDir) {
    try {
      const dir = paneDir(rootDir, pane);
      const hint = buildResumeHint(dir);
      if (!hint) return;
      await sendPrompt(agentName, hint, pane);
      // Optional Discord-mirror callback: lets the bridge post the hint to
      // the bound channel so observers see the same context the pane just
      // got. agent.mjs stays Discord-agnostic; bridge wires up the callback.
      if (onResumeHint) {
        try { await onResumeHint({ agentName, pane, hint, paneDir: dir }); }
        catch (err) { console.warn(`resume-hint mirror skipped: ${err.message}`); }
      }
    } catch (err) {
      console.warn(`resume-hint inject skipped: ${err.message}`);
    }
  }

  async function sendOnly(agentName, prompt, pane) {
    // ensureReady injects the resume-hint at spawn (1.14.0), so no brief-
    // level prepend is needed. Idempotent for full-context panes.
    await ensureReady(agentName, pane);
    await sendPrompt(agentName, prompt, pane);
  }

  async function sendAndWait(agentName, prompt, pane) {
    const wasStarting = !(await isAlreadyRunning(`${agentName}:.${pane}`));
    // ensureReady injects the resume-hint at spawn (1.14.0); no brief-level
    // prepend needed. wasStarting still drives the post-send wait below
    // (claude takes longer to first-turn after fresh spawn).
    await ensureReady(agentName, pane);
    await sendPrompt(agentName, prompt, pane);

    await wait(wasStarting ? 8000 : 3000);

    const deadline = Date.now() + timeout;
    let sawWorking = false;
    let idleStreak = 0;

    while (Date.now() < deadline) {
      await exitCopyMode(`${agentName}:.${pane}`);
      const busy = await isBusy(agentName, pane);

      if (busy) { sawWorking = true; idleStreak = 0; }
      else {
        idleStreak += 2;
        if (sawWorking && idleStreak >= 2) break;
        if (!sawWorking && idleStreak >= 4) break;
      }
      await wait(2000);
    }

    await dismissBlockingPrompt(`${agentName}:.${pane}`);
    return getResponse(agentName, pane);
  }

  // --- Progress timer (thin wrapper around core/progress.mjs) ---

  function startProgressTimer(send, agentName, pane, opts = {}) {
    return createProgressTimer({
      send,
      getSegments: () => getResponseSegments(agentName, pane),
      capturePane: async () => {
        try {
          return await t.capture(`${agentName}:.${pane}`, { lines: 10 });
        } catch (err) {
          console.warn(`progress capturePane failed: ${err.message}`);
          return null;
        }
      },
    }, opts);
  }

  // --- Context ---

  /**
   * Get { percent, tokens } for a pane. Dispatches to the right session
   * store based on the pane's configured cmd (claude vs codex).
   */
  function getContextPercent(agentName, pane = 0) {
    try {
      const config = agentConfig(agentName);
      const dir = paneDir(config.dir, pane);
      const dialect = paneDialectName(agentName, pane);
      return getContextPercentByDialect(dir, dialect);
    } catch (err) {
      console.warn(`getContextPercent(${agentName}) failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Pane-first context read: prefer the percent Claude Code itself renders
   * (status block or custom statusline) over recomputed jsonl math. The two
   * disagree near the limit — jsonl math divides by the RAW model window
   * while Claude Code measures against usable-space-before-autocompact
   * (2026-06-10 incident: 77% vs 92% on the same pane) — and Claude Code's
   * number is the one its own compaction acts on. Falls back to the jsonl
   * path when the pane shows no usable numbers (capture failed, tiny pane).
   */
  async function getContext(agentName, pane = 0) {
    try {
      if (paneDialectName(agentName, pane) === "claude") {
        const config = agentConfig(agentName);
        const dir = paneDir(config.dir, pane);
        const content = await capturePane(agentName, pane, 100);
        const fromPane = getContextFromPane(content, dir);
        if (fromPane) return fromPane;
      }
    } catch { /* fall through to jsonl */ }
    return getContextPercent(agentName, pane);
  }

  // --- Low-level (exposed for CLI) ---

  async function sendEscape(agentName, pane) {
    await t.sendEscape(`${agentName}:.${pane}`);
  }

  /** Bare Enter into a pane: rescue path for palette-eaten submissions. */
  async function sendEnter(agentName, pane) {
    await t.sendEnter(`${agentName}:.${pane}`);
  }

  async function checkAgent(agentName) {
    if (!(await hasSession(agentName))) throw new Error(`No session: ${agentName}`);
    if (!(await isAlreadyRunning(`${agentName}:.0`))) throw new Error(`Claude not running in ${agentName}`);
  }

  return {
    ensureReady, sendAndWait, sendOnly,
    getResponse, getResponseSegments, getResponseStream, getResponseStreamWithRaw, hasResponseForPrompt, isBusy,
    capturePane, sendEscape, sendEnter, dismissBlockingPrompt, waitForPromptEcho,
    startProgressTimer, getContextPercent, getContext, checkAgent, reconcileSession,
    sanitizeTmuxGlobalEnv,
  };
}
