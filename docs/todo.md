# amux todo + todo-remind

Persistent todo list with a daily 08:00 push reminder.

## File location

Storage: `~/.openclaw/workspace/memory/tasks.md`

Reuses the existing markdown format (Idag / snart, Parkerat, Väntar på, Klart).
Override path via `AMUX_TODOS_PATH` env var.

## Format

```markdown
# Tasks

## Idag / snart
- [ ] Bygg s22-backup-scripts <!-- id:5 created:2026-05-27 -->

## Parkerat (tar tag i senare)
- [ ] Skeleton/depth terrain alignment <!-- id:3 created:2026-05-20 -->

## Väntar på
_(Saker som blockas av andra)_

## Klart (senaste)
- [x] /api/logs auth fix <!-- id:4 created:2026-05-25 closed:2026-05-26 -->
```

IDs live in hidden HTML comments — markdown renders cleanly, parser finds them.

## Commands

| Command | Action |
|---|---|
| `amux todo` | List active items (Idag + Parkerat + Väntar) |
| `amux todo --all` | Same + last 20 done items |
| `amux todo add "<text>"` | Add to **Idag / snart** with next free id |
| `amux todo add --parked "<text>"` | Add to **Parkerat** |
| `amux todo add --blocked "<text>"` | Add to **Väntar på** |
| `amux todo done <id\|substring>` | Move to **Klart** with `closed:`-date |
| `amux todo rm <id\|substring>` | Remove permanently |
| `amux todo edit` | Open `tasks.md` in `$EDITOR` |
| `amux todo path` | Print the active file path |
| `amux todo-remind` | Read active items, send push via `notifyuser` (or skip if empty) |

All mutating commands accept `--dry` for a preview.

Substring matching is case-insensitive — `amux todo done s22` finds the first
active item containing "s22".

## 08:00 daily reminder

Install the cron entry:

```bash
~/lsrc/agentmux/bin/install-todo-cron.sh install
```

What it does:

- `0 8 * * *` runs `bin/todo-remind-cron.sh`
- Wrapper calls `amux todo-remind`
- If any active items exist → push notification via `notifyuser`
- Empty list → silent
- Logs to `~/agentmux-todo-remind.log`
- On failure → push notification with error code

Override the schedule:

```bash
CRON_SCHEDULE="0 8,17 * * *" ~/lsrc/agentmux/bin/install-todo-cron.sh
```

Check / remove:

```bash
~/lsrc/agentmux/bin/install-todo-cron.sh status
~/lsrc/agentmux/bin/install-todo-cron.sh remove
```

## Examples

```bash
# Browse active
amux todo

# Add work for today
amux todo add "Verify Modal scale-down deploys cleanly"

# Park something for later
amux todo add --parked "Move /api/logs to SPA route"

# Close it
amux todo done modal      # by substring
amux todo done 5          # by id

# Edit by hand if format gets weird
amux todo edit

# Preview the push that would go out
amux todo-remind --dry
```
