# CLI Reference

`amux` is the command-line interface for controlling agentmux sessions. `ax` is
installed as a shorter alias for the same binary.

## Session Overview

```bash
amux ps
amux top
amux timeline
amux done --since 2h
amux lint
```

| Command | Purpose |
|---|---|
| `amux ps` | Show agents, panes, status, context use, and labels |
| `amux top` | Sort panes by context usage |
| `amux timeline` | Show recent events across panes |
| `amux watch` | Follow the timeline live |
| `amux done` | Summarize commits, active panes, finished panes, and waiters |
| `amux asks` | Show recent human asks/directives with status and jsonl location |
| `amux search` | Search memory, sessions, and the durable delivery ledger |
| `amux lint` | Run default repo linters, starting with WHAT/WHY/DTO/debt contracts |
| `amux churn` | Show WARN-only young-test and rewrite-hotspot signals from git history |

## Bridge Lifecycle

```bash
amux serve            # visible foreground process; Ctrl+C stops it
amux serve --detach   # managed tmux-free background supervisor
amux doctor           # health, tmux geometry/clients, heartbeat, version, and ownership
amux stop             # intentional stop; watchdog does not revive it
amux sync             # sync through the running bridge without changing ownership
amux sync --offline   # standalone sync; safely bounces managed bridges only
```

Foreground is the default so startup failures and restart loops remain visible.
The detached supervisor is identity-proven through its private process receipt,
and the bridge remains discoverable by PID and heartbeat. Agents use `amux
doctor` rather than assuming the bridge must exist inside tmux.
For a manually owned bridge, standalone sync refuses to stop the foreground
process. Passing `amux sync --offline --detach` is the explicit instruction to
transfer it to managed background ownership.

## Search and drill-down

```bash
amux search "restart WSL"
amux search --show 2
amux search "old raw pane detail" --deep
amux search "recovery contract" --semantic
amux search --reindex
```

Lexical search over memory and the durable ledger is the fast, current default.
`--deep` adds the much larger raw session archives. Result state is isolated per
terminal or tmux pane, so one agent cannot replace another agent's `--show N`
list. `--semantic` is explicit because loading the embedding layer is slower;
it always reports the index build time and warns when the index is stale.
Reindexing is never an implicit side effect of a query.

## Native cutover

```bash
amux cutover --all --runtime http://127.0.0.1:8813 --manage-services --drop-shells --allow-empty
amux cutover --all --runtime http://127.0.0.1:8813 --manage-services --drop-shells --allow-empty --apply
amux services status
amux cutover --rollback ~/.agentmux/native-cutovers/<receipt>.json
```

The first command is always read-only. `--apply` proceeds only after every
pane has two idle proofs and an empty durable lane. Existing engine sessions
must be imported exactly; `--allow-empty` permits a fresh session only where
both the session identity and persisted turn history are absent. See [the
full cutover and rollback contract](native-cutover.md).

## Sending Work

```bash
amux <agent> "prompt"
amux <agent> -p <pane> "prompt"
amux wait <agent> -p <pane>
```

Example:

```bash
amux api -p 1 "run backend tests and summarize failures"
amux wait api -p 1
amux log api -p 1
```

When `amux` is called from inside a tmux session, the receiver pane gets a
small provenance header showing which pane sent the brief.

## Reading Logs

```bash
amux log <agent>
amux log <agent> -p <pane>
amux log <agent> -p <pane> -n 10
amux log <agent> -p <pane> --since 30min
amux log <agent> -p <pane> --grep "deploy"
amux log <agent> -p <pane> --tmux
amux log <agent> -p <pane> --full
```

`amux log` defaults to structured jsonl history. Use `--tmux` only when you
need live terminal state, copy-mode output, progress bars, or modal prompts.

| Flag | Behavior |
|---|---|
| `-n N` | Last N structured turns, or lines with `--tmux` |
| `--since T` | Only turns at or after an ISO time or relative time such as `30min` |
| `--grep PAT` | Filter structured turns by case-insensitive regex |
| `--tmux` | Raw tmux capture |
| `--full` | Structured history plus current tmux state |
| `--text` | Legacy filtered text extraction |

## Timeline

```bash
amux timeline
amux timeline -n 100
amux timeline --since 30min
amux timeline --agent claw
amux timeline --agent claw --pane 2
amux timeline --grep "commit"
amux timeline --follow
amux timeline --since 2h --by-pane
```

`amux watch` is a shortcut for `amux timeline --follow`.

Use `--by-pane` when you want a post-mortem grouped by pane. Use plain
`timeline` when chronological order matters more.

## Ask History

`amux asks` answers "what did I ask, where did I ask it, and is it still
open?" It reads structured jsonl, prints a compact prompt preview, the latest
reply preview, and the jsonl file + line + timestamp anchor for drill-down.

```bash
amux asks
amux asks --open
amux asks --since 2h
amux asks claw --pane 3
amux asks --grep "bridge"
amux asks --full --since 30d
```

Default mode is a bounded-tail scan so it is safe as an orientation command.
It supports native-runtime history through that backend's API and does not
read stale tmux aliases. Use `--full` only when you need exact older history
and file/line anchors beyond the recent tail.

## Orchestrator Summary

`amux done` answers "what changed since I last checked?" by combining commit
history and pane state:

```bash
amux done
amux done --since 30min
amux done --since 2h
amux done --day
amux done --week
```

Output groups include:

- Commits across known repositories.
- Panes still working.
- Panes that finished.
- New waiters that likely need input.
- Idle panes.

## Recovery

```bash
amux esc <agent> -p <pane>
amux enter <agent> -p <pane>
amux clearline <agent> -p <pane>
amux keys <agent> -p <pane> Escape C-a C-k
amux wait <agent> -p <pane>
amux log <agent> -p <pane> --tmux
```

Composer control is intentionally narrow. `amux keys`, `amux enter`, and
`amux clearline` apply only to the tmux fallback backend. `amux keys` accepts
exactly `Escape`, `C-a`, `C-k`, `C-u`, and
`Enter`; arbitrary text, tmux flags, and other keys are rejected before the
pane is touched. `amux enter` submits an already visible composer.
`amux clearline` uses the fixed `Escape,C-a,C-k` recipe and never relies on
`C-u`, which does not clear the Codex composer. On tmux panes, `amux esc`
detects Codex's full-screen transcript/backtrack pager and exits it with its
internal `q` recipe in one invocation; native targets retain their existing
adapter-owned Escape path. Every tmux composer control has a durable requested/sent/failed
ledger identity and a best-effort Discord projection; composer text is never
copied into that audit record.

For Discord channels, the equivalent recovery commands are `/raw`, `/esc`,
`/dismiss`, and `//new`.

## Generated agent hints

```bash
amux hints-sync
```

Refreshes `.agents/CLAUDE.md` and `.agents/AGENTS.md` for every workspace root
in the canonical `agents.yaml`. Duplicate session roots are written once. The
generated block is replaced by content, while workspace-specific operator
rules below `<!-- amux-hints-end -->` in `CLAUDE.md` are preserved and mirrored
to `AGENTS.md`. Bridge startup runs the same sync automatically.

The CLI is a fresh process and therefore reads the current template from disk.
If a live bridge heartbeat reports an older or unknown hints version, the
command prints `bridge restart required`; otherwise that older in-memory
template could overwrite the refreshed files on a later pane spawn.

## Labels

```bash
amux label <agent> <pane> "purpose"
amux label <agent> <pane> --clear
amux labels
```

Labels make `amux ps` and `amux top` easier to scan when several panes are
working at once.

## Lint

```bash
amux lint
amux lint ~/lsrc/skydive-altimeter
amux lint ai
amux lint --all-agents
amux lint --changed --strict
```

`amux lint` scans the current repo by default. A target can be a file, a
directory, or an agent name from the agentmux config. The first default check
enforces short `WHAT:/WHY:` contracts, `DTO:` for pure transport shapes, and
explicit `REMOVE:/MERGE:/REFACTOR:/DEPRECATED:` debt tags for symbols that
should not get a fake `WHY:` yet.
With `--strict`, active errors and debt fail the command; style warnings are
reported without failing.
See `docs/contract-lint.md` for the writing rules.

## Churn visibility

```bash
amux churn
amux churn ~/lsrc/agentmux
amux churn --days 30 --young-days 14 --limit 8
```

`amux churn` reads git history without writing files or configuration. It shows
tests and test files removed or rewritten within their first 14 days, plus
source and test files touched by at least three commits in the selected window.
Every finding says `worth a look`: churn may be intentional, so the command is
WARN-only, always exits zero for findings, and is never a PR gate. Invalid
arguments or a non-git path still fail loudly as command errors.

## Worktree dependencies and gates

```bash
amux worktree-deps [path]
amux worktree-deps [path] --check
amux worktree-deps [path] --dry
amux gate --scoped [path]
amux gate --scoped [path] -- command arg...
amux proof --config proof.json --output attestation.json
```

`worktree-deps` scans tracked lockfiles, including nested UI package roots.
Relocatable npm installs use a content-addressed cache under the primary
repository root and outside `.git`; each worktree materializes an
`immutable-copy` locally with copy-on-write where supported and a safe copy
fallback. Dependency realpaths therefore remain inside the consuming worktree.
The cache key includes the exact manifest, lock, repository `.npmrc`, npm
version and runtime ABI. Workspace/file-linked npm trees stay local. Python
virtualenvs are never shared: the command replaces an unsafe `.venv` symlink
with a local `uv sync --locked` environment.

`--check` is mutation-free and exits non-zero for a missing, stale, or unsafe
root. `--dry` prints the provisioning plan. The standalone
`node bin/worktree-deps.mjs` entry point uses only Node built-ins, so it works in
the exact fresh-worktree state where the normal CLI's dependencies are absent.

`gate --scoped` performs the bootstrap, then runs the repo's full gate. It
prints `Skipped: none` on a complete run or names every root it could not
provision. Skips are never green. The gate also exports `UV_LOCKED=1` and hashes
all tracked npm/uv locks before and after execution, preventing an otherwise
green test command from dirtying the worktree's dependency contract.

`proof` takes an argv-only JSON recipe. It creates clean detached base/head
worktrees, asserts a named fixture anchor before applying the test-only patch,
rejects a no-op, runs the same real gate exactly once red and once green, and
requires the green gate to write a numeric margin to
`$AMUX_MEASUREMENT_OUTPUT`. Shell and source-grep commands are rejected. The
canonical output is bound to the ticket, assignment generation, commits,
fixture hash, gate output hashes and positive margin; it is the
`measurementBoundary` value accepted by Suggestions completion policy v2.
The gate must write exactly `metric`, `unit`, `operator`, `limit`, and
`observed` to the path in `$AMUX_MEASUREMENT_OUTPUT`; agentmux computes and
requires a strictly positive margin. `prepare` is optional and runs once per
detached worktree before either measured gate.

```json
{
  "schemaVersion": 1,
  "ticketId": "SRC-0092",
  "assignmentGeneration": 1,
  "repository": ".",
  "baseRef": "origin/main",
  "headRef": "HEAD",
  "fixturePatch": "./tmp/src-0092-red-first.patch",
  "anchor": {
    "path": "tests/assignment-watchdog.test.ts",
    "contains": "protocol 1.1 assignment roots"
  },
  "prepare": {
    "argv": ["node", "/opt/agentmux/bin/worktree-deps.mjs", "."],
    "cwd": "."
  },
  "gate": {
    "argv": ["npm", "run", "test:measurement"],
    "cwd": "."
  }
}
```
