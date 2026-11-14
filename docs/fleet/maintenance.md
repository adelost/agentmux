# Health and maintenance

## Health and maintenance

- `amux doctor` classifies before any restart (installed CLI, running bridge
  and merges can differ); never start disabled services for green.
- `amux quota`: the actual provider/window, never a guess from an error;
  accounts and switching: amux-accounts skill.
- `amux compact --dry`: eligibility; never force compact/respawn through active work.
- `amux memory status`, `amux memory context` (sections on demand, never whole
  daily files), `amux dream --help`; a scheduled run is not proof of a saved digest.
- `amux wait PROJECT -p N -t 45`: bounded wait at a real handoff.
- `amux pulse io`: how the bridge reached tmux since start (control-client questions,
  process starts, shadow differences); measure before claiming a bridge cost.
- Lifecycle commands (restart/stop/serve/runtime/emulator/esc/select) affect
  other work: read help, verify the target, coordinate its owner; never replace
  a manual bridge with a detached daemon without authorization.

## Heavy jobs share the host

- A job that runs over 10 minutes at a core or more, or holds over 2 GB (a
  training run, a search over the whole disk, a render batch, a whole test
  suite, a disk scan), starts as
  `flock ~/.agentmux/heavy.lock nice -n 19 ionice -c 3 <command>`. The lock
  lets one heavy job run at a time and the next one wait for it.
- Before the start, read `uptime` and the RAM guard's level
  (`cat ~/.agentmux/memory-guard.json`, field `level`; `amux memory status`
  shows notes, not RAM): above load 24 (the host's cores), or at `blocked` or
  `critical`, the job waits.
- Gates before a push, a release and a deploy are not heavy jobs and are never
  niced. The disk guard's own cleanup already runs at Nice=15 with idle I/O
  and takes no lock.
- Why: on 14 Nov 2026 a whole-disk search (700 s), a new training run and a
  manual disk cleanup ran together at load 54; a pre-push lint that takes 5.9 s
  hit its 65 s limit and an urgent fix's push needed a second try, 5 minutes
  (deep:5 for Mattias, delivery:07a47426fabf12506ecfc04b1f8903c9).
