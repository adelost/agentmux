# Context

## Context and compaction

- Never mid-turn, or while a subagent or terminal works, a prompt is open or a delivery is pending.
- A big context compacts at its turn end; leaders keep more than builders.
- Idle panes compact before their prompt cache expires, Codex panes sooner since theirs expires sooner.
- A pane idle past its cache's life compacts before its next delivery, when that pays back.
- A pane's own recurring check waits less than its idle compaction after its last call: Claude under 50 minutes (Claude Code's self-paced /loop, never an hourly cron), Codex under 25.
- At banked boundaries: `amux compact --self --continue-file HANDOFF`. `--no-resume` means maintenance only.
- Bounded tasks go to a fresh subagent with a brief; continue your own work after a compact.
- Write what a compact loses to files as you work: quotes, numbers, decisions.

Belägg: `~/.openclaw/workspace/memory/references/claude-subagent-cache-2026-10-10.md`
("Kompaktering: valen och varför"). Ändra en regel bara med nya mätningar mot de där.
