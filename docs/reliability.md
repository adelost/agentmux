# Reliability

agentmux includes operational safeguards for long-running multi-agent sessions.
These controls are intentionally small and explicit: they pause unsafe flows,
surface recovery commands, and keep session state inspectable.

## Loop Guard

Loop Guard watches incoming Discord messages per pane. If the same short
message arrives repeatedly inside a short window, forwarding to that pane is
paused and a single warning is posted in the channel:

```text
Loop detected: '0' x 3 in 2s. Forwarding paused. Reply something different to resume, or run `amux esc` to clear pane state.
```

Repeated messages during the same block period are dropped without additional
warning noise. Sending any different message resets the block and resumes
normal forwarding.

The guard only watches user-to-pane forwarding. Long prompts pass through
unchanged, so normal task briefs are not affected.

### Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `LOOP_GUARD_ENABLED` | `true` | Set `false` to disable entirely |
| `LOOP_GUARD_THRESHOLD` | `3` | Identical short messages before blocking |
| `LOOP_GUARD_WINDOW_MS` | `30000` | Sliding window in milliseconds |
| `LOOP_GUARD_SHORT_LEN` | `10` | Messages longer than this are ignored by Loop Guard |

## Drift Guard

Long-running Claude panes can become less consistent with their generated
project instructions after many turns. Drift Guard tracks pane activity and can
remind idle panes to refresh their `.agents/CLAUDE.md` context after a
configurable turn threshold.

The bridge polls Claude panes. When the turn threshold is exceeded and the pane
is idle, a short reminder is sent into the pane.

Manual reminders are available through `amux remind`:

```bash
amux remind <agent> -p <pane>    # single pane, unconditional
amux remind --all                # every live, recently used Claude pane; never wakes sleepers
amux remind --stale              # only panes past the threshold
amux remind --stale --threshold 30 # override threshold for stale active panes
```

`remind` updates the shared state file so the auto-poll does not re-fire the
same pane until another threshold window has passed.

### Configuration

| Variable | Default | Description |
|---|---:|---|
| `AMUX_REMIND_ENABLED` | `true` | Set `false` to disable the poll |
| `AMUX_REMIND_TURN_THRESHOLD` | `40` | Turns since refresh before reminder fires |
| `AMUX_REMIND_ACTIVE_WINDOW_MS` | `3600000` | Recent-work window; maintenance never qualifies a pane |
| `AMUX_REMIND_POLL_MS` | `60000` | Milliseconds between poll ticks, minimum 10s |
| `AMUX_REMINDER_STATE_PATH` | `/tmp/agentmux-reminder-state.json` | Per-pane reminder state |

## Auto-Compact

The bridge can warn and compact idle panes before they approach context-limit
failure. Activity cancels a pending compact, so the feature targets idle panes
rather than active work.

```text
Auto-compact in 60s: claw:3 is at 78% context and idle. Type anything to cancel.
Auto-compacting claw:3 (was 78%). Summary preserves recent context.
```

### Configuration

| Variable | Default | Description |
|---|---:|---|
| `AUTO_COMPACT_ENABLED` | `true` | Set `false` to disable the poll |
| `AUTO_COMPACT_WARN_THRESHOLD` | `70` | Context percentage that triggers a warning |
| `AUTO_COMPACT_GRACE_MS` | `60000` | Milliseconds between warning and compact |
| `AUTO_COMPACT_POLL_MS` | `60000` | Milliseconds between poll ticks |
| `AUTO_COMPACT_MIN_IDLE_MS` | `300000` | Required conversation silence before warning |

### Claude quota recovery

When Claude returns its exact session-limit response, every AMUX send path
blocks before writing into that pane. A bridge preload parks existing durable
jobs, polls fresh OAuth usage, and restarts only the exact persisted Claude
session after a top-up or reset. One idempotent continuation turn resumes at
the limit checkpoint; the original task is never replayed from the beginning.
If quota telemetry is unavailable, the reset time in persisted session history
is the conservative fallback. A later human turn invalidates the receipt and
prevents stale automation from killing the pane.

| Variable | Default | Meaning |
|---|---:|---|
| `AMUX_QUOTA_RECOVERY_ENABLED` | `true` | Set `false` to disable automatic exact-session recovery |
| `AMUX_QUOTA_RECOVERY_POLL_MS` | `30000` | Fresh quota check interval while a Claude receipt is active |
| `AMUX_QUOTA_RECOVERY_RESET_GRACE_MS` | `15000` | Grace after reset before clock-based fallback |

## Recovery Commands

Use these when a pane appears stuck or the bridge cannot confirm delivery:

```bash
amux log <agent> -p <pane> --tmux
amux esc <agent> -p <pane>
amux wait <agent> -p <pane>
```

In Discord channels, `/raw`, `/esc`, `/dismiss`, and `//new` provide the same
operational recovery path without attaching to tmux directly.
