# Handing work on and staffing

## Staffing and review economics

1. **One owner per feature, end to end.** The direct recipient owns it;
   one busy with another feature hands it to one free owner with a brief.
   A capable idle agent may also self-claim one READY or explicitly
   claimable board ticket. The owner plans, builds, verifies, rebases,
   self-merges, deploys when needed and records the completion commit;
   scope follows the full root-fix seam.
   Before handing work on, find who already built, measured or planned
   that area (`~/.agentmux/ROSTER.md` first, then
   `amux search`, day files, repo history); prefer that owner when free,
   else point the new owner at its plans, evals and artifacts, so
   nobody redoes a measurement that exists.
   The Dream curator pane (sandman:0) is for meta-analysis and his
   questions, never a worker.

2. **Managers are sidecars, not gateways.** They act on a stall, collision,
   delivery failure or idle-capacity gap. Work, decisions, merge and delivery
   need no manager round-trip.

3. **Do not wake a fleet to look busy.** A durable task wakes its exact owner;
   dormant panes stay dormant. "Sync/check all panels" means reading status
   and evidence, not prompting. FYI messages spend quota too: contact only
   owners who need an action or handoff; idle panels or unused providers are
   no permission to activate them. A pane back after 7+ days first re-reads
   `amux done --week`, `amux asks --open`, this policy and the repo's
   instructions. `amux reconcile` repairs service/shell panes; it is not a
   staffing command and never wakes coding agents. The recipient's receipt,
   not enqueue time, proves delivery and starts the owner's clock.
   Hand a lead role only to a running pane that acknowledged it; until
   then the sender keeps it.

   Staffing (updated 2026-10-21): Opus designs and also implements work whose
   quality depends on visual, UX or gameplay judgment. Codex and Sonnet 5.5
   handle mechanical implementation, tests, data and infrastructure. Sonnet may
   design as a fallback. Finish already assigned work before reallocating it.
   Do not route mechanical builds to Claude subagents instead of available
   authorized builders. A model role creates no separate merge owner: the
   feature owner keeps delivery under the repo's required proof.
   Codex models (Mattias, 2026-09-20, 2026-10-11): default `gpt-6.1-sol`,
   never Astra; Claude and Kimi keep theirs; a pane's choice survives restart.
   Change models only via Discord `/model sol` or `amux model PROJECT -p N
   sol` (raw `/model` refused); dormant panes switch at their next work
   prompt, never by a fleet wake-up. Read model and tokens from the exact
   pane; quota is paid capacity. Account moves require a reached weekly limit or a verified wind-down compact,
   verified room and the exact session. An operator-requested Codex switch also skips
   source compact at a provider-confirmed spent 5h window; pending floor-held prompts
   follow, but delivery in flight still holds the switch. Forecasts alone never switch.

4. **Respect actual availability.** One active feature per agent. Never stack
   work on a pane that is working, in a modal, or between tool calls.
   A blocked task does not reserve its pane indefinitely:
   checkpoint it and release its active resources before taking independent work.
   Honor the project's concurrency limit; invent no extra parallelism. A board lease alone does not prove a pane is free.

5. **One allocator, one shared-resource lock.** The project lead owns who does
   which row, and the task ledger on trunk is the answer. When two
   assignments cross, the ledger wins. The dispatcher confirms the ledger,
   or asks the lead to change it, and never sends its own reassignment to
   builders. (23 Oct: two rows changed owner five times in 25 min,
   because under load each message arrived 7–9 min late.) Shared machine
   resources (browser lanes, ports, test accounts) are taken through the
   repo's slot lock, which waits. Agents do not agree on "windows" by
   message. (Four collisions on the night of 22–23 Oct before Cutkit's slots.mjs.)
   Each agent that tests live uses its own synthetic account, or takes the
   account's slot.

## Subagents

Never fork or copy a session into a subagent (Mattias 2026-10-10: "vi borde
väl förbjuda det helt"). AMUX blocks Claude forks; in Codex call
`spawn_agent` only with `fork_turns="none"`. Start a fresh subagent with a
short written brief.
