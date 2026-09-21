import { DEFAULT_TMUX_SOCKET } from "../core/runtime-defaults.mjs";

/** WHAT: Formats CLI commands and token-only compact usage. WHY: Keeps operator guidance separate from command dispatch. */
export function cmdHelp(ctx = {}) {
  const help = `agent: Manage Claude Code/Codex tmux sessions

Usage:
  agent                           List agents (● = running)
  agent <name|:nr>                Attach to agent session
  agent <name|:nr> "prompt"       Send prompt to agent
                                  Short slash commands ("/usage", "/model") are
                                  delivered raw, without a [from] prefix, so the
                                  engine runs them instead of reading them
    -n <channel>                  Notify Discord channel when done
    -m <session>                  Message OpenClaw session when done
    --notify-user                 Mobile-push the human when done/problem
    -p <pane>                     Target specific pane (default: 0)
    -q                            Quiet (no confirmation output)
    --stdin                       Read a bounded prompt from stdin (automation)
    --                            Treat remaining arguments as literal prompt text
    --idempotency-key <key>       Reuse one durable queue identity on retry
    --wait-ms <0-12000>           Bound automation receipt wait (enqueue is already durable)
  agent add <name> <dir>          Add new agent
  agent rm <name|:nr>             Remove agent
  agent stop <name|:nr>           Stop tmux session (keep config)
  agent reconcile <name|:nr>      Respawn dead service/shell panes to match config
                                  (preserves live coding-agent panes; use instead of stop+start
                                   when only services died)
  agent serve                     Run Discord bridge here; Ctrl+C stops it
    --detach, -d                  Run under a managed tmux-free supervisor
  agent suggest                   Poll Suggestions here; Ctrl+C stops all Suggestions polling
    --once                        Run one diagnostic poll without changing legacy cron ownership
  agent work [status|join|add|approve|claim|working|wait|block|answer|done]  Simple durable pull workflow
  agent stop                      Stop Discord bridge (no arg = bridge)
  agent stop --all                Stop bridge + all agent sessions
  agent runtime status            Every managed native runtime + engine health
  agent runtime check             Exit non-zero unless the selected runtime answers health
  agent runtime start             Start native runtime detached (no tmux)
  agent runtime stop              Stop it only while idle (sessions persist)
  agent runtime restart           Controlled idle restart
    --port N                      Select one runtime (start/stop default 8811)
    --data-dir PATH               Registry/uploads directory
    --state-dir PATH              PID/log ownership directory
    --no-legacy-migration         Do not import checkout-local spike history
    --force                       Permit stopping active turns
  agent services status [name]    Native service process ownership + logs
  agent services start [name]     Start configured native services without tmux
  agent services stop [name]      Stop only ownership-verified process groups
  agent cutover <name...>         Dry-run exact-session tmux → native migration
    --all                         Target every remaining tmux agent group
    --runtime URL                 Loopback native runtime (default 127.0.0.1:8811)
    --apply                       Execute only after two idle/queue/session proofs
    --drop-services               Explicitly discard configured service panes
    --manage-services             Move service panes to the tmux-free supervisor
    --drop-shells                 Explicitly discard configured shell panes
    --allow-empty                 Fresh sessions only for proven-empty panes
    --rollback RECEIPT            Byte-exact config restore + tmux restart
  agent log <name|:nr> [-n N]     Show agent output (default: last 3 turns from jsonl)
    -n N                          Number of turns (jsonl) or lines (--tmux)
    -p <pane>                     Target pane
    --since T                     jsonl: only turns at/after T (ISO or '30min')
    --grep PAT                    jsonl: only turns matching regex PAT (case-insensitive)
    --tmux [-s N]                 Raw tmux capture, scrollback depth N (default 200)
    --full                        Both jsonl history AND current tmux state
    --text                        [legacy] Filtered tmux extract (pre-jsonl default)
  agent wait <name|:nr> [-t S]    Wait until agent is ready
  agent select <name|:nr> [-p N] <N> Select menu option N
  agent keys <name|:nr> [-p N] <key...>
                                  Send only Escape,C-a,C-k,C-u,Enter
  agent enter <name|:nr> [-p N]   Submit the current composer with Enter
  agent clearline <name|:nr> [-p N]
                                  Clear composer with Escape,C-a,C-k
  agent esc <name|:nr> [-p N]     Escape, or close a detected Codex pager
  amux prompts [answer <agent> [-p N] <N>]  Blocked permission prompts; answer one
  agent ps                        Show all running agents + status + context%
  agent top [--sort tokens] [-n N] Cross-session context leaderboard
  agent timeline [-n N]           Cross-pane event stream (kronologisk)
    --since T                     Only events at/after T (ISO or '30min')
    --agent NAME                  Filter to one agent
    --pane N                      Filter to one pane (requires --agent)
    --grep PAT                    Regex filter on content
    --follow, -f                  Live-tail (like tail -f)
  agent watch [--agent] [--pane]  Shortcut for 'timeline --follow'
    [--grep PAT]
  agent asks [-n N]               Recent human asks/directives with status + jsonl location
    --open                        Only open-ish asks (open/working/partial/needs-you)
    --since T                     Window (default 7d; ISO or '30min')
    --agent NAME --pane N         Filter to one pane
    --grep PAT                    Regex filter over ask/reply text
    --full                        Exact older scan (slower); default is bounded tail
    --all-repos                   Include archived agents outside active config
    --summary                     Group matching durable asks by repository
  agent done                      Attention-first fleet overview (default: last 1h)
    --since T | --day | --week    Select a time window; --all is capped at 30d
  agent edit                      Open agentmux.yaml in $EDITOR (source config)
  agent label <agent> <pane> <text> Set per-pane label (shown in amux ps/top)
    --clear                       Remove the label instead of setting one
                                  (note: rewriting agentmux.yaml via label
                                   may drop comments; use 'amux edit' to preserve)
  agent labels [agent]            Show labels table, optionally filtered to one agent
  agent lint [target]             Run default repo linters (WHAT/WHY/DTO contracts)
    --all-agents                  Lint every configured agent directory
    --changed                     Only changed files
    --strict                      Exit non-zero on active error/debt findings
    --baseline <path>             Suppress baseline findings\n    --update-baseline             Write current findings to baseline
  agent churn [path]              WARN-only young tests + rewrite hotspots from git history
  agent worktree-deps [path]      Provision every tracked npm/uv root in a worktree
    --check                       Verify only; fail on missing, stale, or unsafe deps
    --dry                         Show the immutable-copy/local-venv plan
  agent gate --scoped [path]      Bootstrap deps, run the repo-owned full gate, report skips
    --dry                         Show dependency + gate plan without changing anything
    -- command ...                Override gate discovery with an explicit argv-safe command\n  agent proof --config FILE [--output FILE]  Run a clean red-first measurement
  agent compact                  Bulk: /compact to idle panes above 100k tokens
  agent compact <agent> [-p N]    Target ONE pane (skips thresholds, keeps working-guard)
    -m "focus"                    Steer the summary: sends '/compact <focus>' (what to preserve)
                                  Bulk uses --min-tokens N; an explicit pane skips the token threshold
    --dry                         Show what would compact, do nothing
    --force                       Include 'working' panes (default: skip)
  agent dream                     Write/update nightly pane digest in workspace memory
    --since T                     Window to summarize (default: 24h)
    --dry                         Preview pane work, do nothing
  agent janitor [--dry] [--days N] Trim oversized fields in aged session jsonl; never delete records\n  agent trim [--dry]              Reclaim pre-checkpoint bytes from inactive oversized Claude/Codex sessions\n  agent doctor [--workspaces]     Health: services + Git workspaces; --workspaces checks only Git (exit 0/1/2)\n  agent revive                    Post-boot: classify interrupted panes (ledger + Codex/Kimi journals) and selectively revive only them; --all for legacy whole-fleet respawn, --dry to preview\n  agent memory status             Memory warnings, compact backlog, latest dream
  agent queue                     List live durable delivery jobs (id, target, age, state, attempts, reason, preview)
  agent sleep <name|:nr> [-p N]   Sleep one 24h-idle Claude pane after exact compact, nonce, and clean-state receipts
  agent wake <name|:nr> [-p N]    Wake the exact recorded session through release and memory admission
  agent sleep-watch [--dry]       Report conservative candidates; --apply sleeps at most two after re-gating
    --all                         Include terminal delivery history retained on disk
    --limit N                     Maximum rows (default 100, max 1000)
    --json                        Machine-readable output
  agent queue cancel JOB_ID --reason TEXT
                                  Request pre-submit cancellation; broker decides safely
  agent memory context            Dated memory references, no diary text (--json, -p agent:pane)
  agent memory lint               Structured memory lint (--json, exit 1 on warnings)
  agent memory compact --dry      Preview old daily-file backlog (automatic model rewrite disabled)
  agent search "term"             Source-bound topics + memory/ledger; --show N expands, --raw omits topics
    --deep                        Include large raw session archives
    --semantic                    Opt into slower semantic search (index age is always shown)
    --reindex                     Rebuild the semantic index explicitly
    --dry                         List deletion candidates, change nothing
    --days N                      Retention window (default: 14)
  agent playwright-reap           Reap stale Playwright-MCP/browser processes
    --dry                         List process candidates, change nothing
    --minutes N                   Stale age threshold (default: 60)
  agent notifyuser "message"      High-signal mobile notification to the human
    --level info|done|warn|error  Notification level (default: info)
    --idempotency-key <key>       Use a stable Discord nonce for crash-safe retry
    --test                        Send a test notification
  agent image <path> [caption]    Send a local image file to the bound Discord channel
    -c <channelId>                Explicit Discord channel ID
    -p <agent>:<pane>             Explicit agent:pane channel mapping
    --dry                         Print target without posting
  agent say "text"                Explicitly send one spoken MP3; never automatic
    --stdin                       Read exact UTF-8 speech from a file or pipe
    -c <channelId>                Explicit Discord channel ID
    -p <agent>:<pane>             Explicit agent:pane channel mapping
    --voice <name>                Override the configured edge-tts voice
  agent quota [--all] [--json]    Subscription quota for every configured coding account
  agent accounts                  Same account overview, grouped by provider profile
  agent accounts login TYPE:ID    Print a provider-scoped login command; never exposes tokens\n  agent accounts rotate claude:ID Switch idle Claude panes with exact history, no source model turn (--dry)
  agent r                         Resume last agent
  agent help                      Show this message

Bridge controls (talk to the running bridge):
  agent sync                      Trigger Discord channel sync from agentmux.yaml
    --offline [--detach]          Standalone sync; managed bounce or explicit manual→managed takeover
                                  (slower; use when bridge is wedged or absent)
  agent hints-sync                Refresh generated CLAUDE.md/AGENTS.md in every configured workspace
  agent reload                    Reload agents.yaml without restarting (SIGHUP)
  agent restart                   Restart bridge (SIGUSR2 → exit 75 → start.sh respawn)
    --all                         Recreate every configured tmux session, then restart bridge
  agent thinking [on|off|toggle|status]
                                  Real-time text streaming flag (default on)
  agent tts [on|off|toggle|status]
                                  Legacy preference only; never triggers automatic speech

Config source: ${ctx.sourceConfigPath || "~/.agentmux/agentmux.yaml"} (generated runtime config stays internal)
Socket: ${ctx.socket || process.env.TMUX_SOCKET || DEFAULT_TMUX_SOCKET}`;
  console.log(help.replace(/^agent/u, "amux").replace(/^  agent/gmu, "  amux"));
}
