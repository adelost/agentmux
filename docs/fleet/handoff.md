# Handing work on and staffing

## Row brief

A row goes to its builder with these eight things, in this order, in one message or one file. A brief that lacks an applicable part is not sent.

1. **Outcome**: one sentence, what a person can do or see when it is done. The source (his delivery id or the time of his words).
2. **Where**: every file the change touches, as `path:line`, read by the planner in today's master. The builder opens them; it does not look for them.
3. **Sizes**: for anything seen, numbers (px, the token's name, the place in the row), not only a picture. A board is attached with its width.
4. **Kit first**: which kit part draws it, and whether the part gets an option or a new default. No page CSS for a look other apps share.
5. **Removed**: every control, word or function that goes away, each with his word that says it may. An open question from him is not a yes; without his word it stays.
6. **Unchanged**: what must look and work the same, at 390 and 1280 when the row has a view.
7. **Proof**: for a view, one image, live beside the board at the same width, with the differences that remain listed by the builder. Existing tests named; no new test files.
8. **Done when**: the sentence that closes the row.

Sizes, kit first and the picture beside the board apply to rows that change something seen. A row without a view names its proof as a command or a log line.

After the brief:

- The builder builds, runs its own gates, rebases, pushes and releases when green. Nobody is asked first and nobody waits.
- The builder writes one message at DONE or at a real stop: the change, the main number, the image or the sha. No progress notes.
- The planner reads the pair after the release and answers yes or what is missing; what is missing is mended forward.
- Rows that touch the same files name each other in the brief, and each builder rebases on the other; neither waits for the other's release.

Source: deep:0's row brief, 15 Nov 2026, from Mattias in deep:0's channel about 20:3xZ; deep:5's conditions for rows with and without a view.

## Staffing and review economics

1. **One owner per feature, end to end.** The direct recipient owns it;
   one busy with another feature reports the collision so the allocator can
   name one free owner with a brief.
   The allocator names the owner and marks the row READY in TASKS.
   An idle owner may start only its own READY row, after its stated dependency.
   The owner plans, builds, verifies, rebases,
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
   need no manager round-trip after allocation and the one brief.
   Explicitly requested human approval still applies.
   Send DONE, stops or decisions to the one next actor, without FYI copies.
   Checkpoints update TASKS rather than starting another message round.

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

   Plan on Claude, build on Codex (Mattias 15 Nov 2026 07:42Z and 08:03Z, delivery:c1a2dfff13d100097f1541a03fd6f7b6 and delivery:899075e519e5661a40f754cabb5c60a2): a build row's owner is a Codex pane, named by the allocator. The Claude pane that knows the area writes the plan first (the fault or the outcome, the change with file:line, what must not change, the test cases in existing files, done-when, how it is proven), sends it straight to the owner and reads the commit against it. A Claude pane builds only work whose quality depends on visual, UX or gameplay judgment, and its row says so. Deep panes never build.

   Staffing (updated 2026-10-21): Opus designs and also implements work whose
   quality depends on visual, UX or gameplay judgment. Codex and Sonnet 5.5
   handle mechanical implementation, tests, data and infrastructure.
   When Claude quota is unavailable, Codex may design with
   mattias-product-ux; show designs before building when the task requires it.
   Sonnet may also design as a fallback. Finish already assigned work before reallocating it.
   Do not route mechanical builds to Claude subagents instead of available
   authorized builders. A model role creates no separate merge owner: the
   feature owner keeps delivery under the repo's required proof.
   Codex models (Mattias, 2026-10-11, 2026-10-27): default `gpt-6.1-terra`,
   never Astra; Claude and Kimi keep theirs; a pane's choice survives restart.
   Change models only via Discord `/model terra` or `amux model PROJECT -p N
   terra` (raw `/model` refused); dormant panes switch at their next work
   prompt, never by a fleet wake-up. Read model and tokens from the exact
   pane; quota is paid capacity. Account moves require a reached weekly limit or a verified wind-down compact,
   verified room and the exact session. An operator-requested Codex switch also skips
   source compact at a provider-confirmed spent 5h window; pending floor-held prompts
   follow, but delivery in flight still holds the switch. Forecasts alone never switch.

4. **Respect actual availability.** One active feature per agent. Never stack
   work on a pane that is working, in a modal, or between tool calls.
   A blocked task does not reserve its pane indefinitely:
   write it BLOCKED with its clock and release its active resources before taking independent work.
   Honor the project's concurrency limit; invent no extra parallelism. A board lease alone does not prove a pane is free.

5. **One allocator, one shared-resource lock.** The project lead owns who does
   which row, and the task ledger on trunk is the answer.
   If that lead is unreachable through quota or a crash, the already authorised
   dispatcher acts as lead and records the allocation there. Hand back explicitly
   when the lead returns; do not run two allocators or a private handoff task list.
   When two
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
