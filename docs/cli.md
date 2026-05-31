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
| `amux lint` | Run default repo linters, starting with WHAT/WHY/DTO contracts |

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
reply preview, and the jsonl file + timestamp anchor for drill-down.

```bash
amux asks
amux asks --open
amux asks --since 2h
amux asks claw --pane 3
amux asks --grep "bridge"
amux asks --full --since 30d
```

Default mode is a bounded-tail scan so it is safe as an orientation command.
Use `--full` only when you need exact older history beyond the recent tail.

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
amux wait <agent> -p <pane>
amux log <agent> -p <pane> --tmux
```

For Discord channels, the equivalent recovery commands are `/raw`, `/esc`,
`/dismiss`, and `//new`.

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
enforces short `WHAT:/WHY:` contracts and `DTO:` for pure transport shapes.
See `docs/contract-lint.md` for the writing rules.
