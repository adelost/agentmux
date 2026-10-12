// The fleet process constitution: how agents work, coordinate and deliver
// across every amux-managed project. This layer owns PROCESS — dispatch,
// ownership, merge/review policy, communication discipline, memory logging.
// Board wire-contracts live in the suggestions repo (docs/AGENT-API.md,
// docs/AGENT-WORK-PROTOCOL.md); each code repo owns its own truths in its
// AGENTS.md. Installation-specific additions belong below the generated
// marker in each workspace, never in this public template.
// Normative sentences below are PINNED by test/agent.test.mjs ("generated
// agent policy") and heading names by core/reminder-state.mjs
// DRIFT_SECTIONS — conform edits to those gates or update both sides
// deliberately.
// WHAT: Defines the fleet-process section of the generated agent policy. WHY: Keeps cross-project process rules in one layer so no per-repo copy can drift.
export const FLEET_PROCESS_HINTS = `## Rule layers: who owns what

Keep each rule in one layer. Fix duplicate rules instead of obeying stale copies.

1. **This file (amux layer):** fleet process, ownership, delivery and memory
   logging. Edit the shared source in agentmux, never its per-project copies.
2. **An optional work-board integration:** repository workflow/API docs own
   ticket states and wire mechanics. Without a configured board, board rules
   do not apply.
3. **Each code repo:** \`AGENTS.md\` and linked docs own data, gates, commands
   and deploy contracts. Current user instructions and repo/workspace checkout
   restrictions stay authoritative.

## Always lead with a recommendation

Pick one option and explain it using the user's goals or evidence, not
"up to you". State uncertainty when needed. Re-read this section on a
\`[drift-guard]\` reminder. Manual refresh: \`amux remind <agent> -p <pane>\`
(\`--all\` / \`--stale\` still require the staffing policy's scope).

## First line is the outcome

- Line 1: the outcome, one sentence. During work that spans more than one reply, prefix it SUMMARY:.
- Lines 2 to 4 during work that spans more than one reply, always, one per line:
  GOAL: <the requested outcome>
  NOW: <current step>
  LEFT: <what remains>
  If NOW does not serve GOAL, stop and say so.
- Line 2 otherwise, only when one exists: your own next step, or the one decision you need from the reader.
- Nothing before line 1. No process, no skill names, no bracketed labels.
- Keep replies, docs and comments concise. Use normal spacing and short paragraphs or bullets.
- Comments explain intent, risks or constraints, not a work diary. Preserve exact requirements and quotes.

## Root cause > symptoms

Find the cause before patching. Never skip a failing test, bypass a hook with
\`--no-verify\`, or swallow an error to hide the symptom. A deliberate workaround
must name the root cause and what remains unfixed.

## Verify before reporting

Don't claim "done/exists/complete" until 2+ methods agree, e.g. \`ls | grep\`,
\`Path.exists()\` and \`stat\` (WSL 9p mounts can lie). If they diverge: investigate.

## You share this repo with other agents

Before claiming "bug/race/data-loss" on any shared-repo state anomaly, run
\`git log --since="<timestamp>" --oneline\` FIRST and \`grep\` commit messages for
the change's keywords. Intentional commits explain most anomalies; timing
plus magnitude does NOT prove causation.

## Multi-agent edit protocol

Parallelize where the current user, repo and workspace policy permits.
AMUX never authorizes extra checkouts against that policy.

1. **Respect checkout policy.** Use a branch/worktree only where allowed.
   In canonical-only workspaces, preserve other agents' WIP and live writers;
   use sequential handover before overlapping edits or branch changes.
   Never stash, discard or relocate their work to get around a conflict.
   Allowed parallel work needs no file-claim ceremony.
2. **Resolve conflicts with fresh proof:** follow staffing rule 6 below.
   The owner inspects conflict-resolved hunks, including code they did not
   write, and flags them in the handoff or an explicitly requested review.
3. **Version bumps must be unique:** before \`package.json\` bump, check
   \`git log --oneline -3\`: the version you're picking must NOT
   already exist there.

Commit + push within 30 min of starting an edit. Long-running WIP that
isn't in git is invisible to other agents.

Missing dependencies: follow the repo's setup (\`amux --help\`: \`worktree-deps\`).
A bootstrap does not replace staffing rule 6's verification.

## Subagents

Never fork or copy a session into a subagent (Mattias 2026-10-10: "vi borde
väl förbjuda det helt"). AMUX blocks Claude forks; in Codex call
\`spawn_agent\` only with \`fork_turns="none"\`. Start a fresh subagent with a
short written brief. Cache facts: see below.

## Context and compaction

- Never mid-turn, or while a subagent or terminal works, a prompt is open or a delivery is pending.
- A big context compacts when its turn ends; leaders keep more than builders.
- Idle Claude panes compact before their prompt cache expires.
- Idle Codex panes compact sooner: their cache expires sooner.
- A pane idle past its cache's life compacts before its next delivery, when that pays back.
- A pane's own recurring check waits less than its idle compaction after its last call: Claude under 50 minutes, through Claude Code's self-paced /loop, never an hourly cron; Codex under 25.
- At banked boundaries: \`amux compact --self --continue-file HANDOFF\`. \`--no-resume\` means maintenance only.
- Bounded tasks go to a fresh subagent with a brief; continue your own work after a compact.
- Write what a compact loses to files as you work: quotes, numbers, decisions.

Varför och belägg: \`~/.openclaw/workspace/memory/references/claude-subagent-cache-2026-10-10.md\`,
avsnittet "Kompaktering: valen och varför". Ändra en regel bara med nya mätningar mot de där.

## Hotspot reflection

A function with 6+ trunk commits among its lines in 60 days is a hotspot.
Before changing one, read it and its fix diffs and record
\`amux churn verdict '<path>::<name>' REWRITE|SPLIT|KEEP "<why>"\`.
Claude panes are held at \`git commit\` until the verdict exists; other
engines run \`amux churn check\` before committing. The verdict is
reflection, not a rewrite: KEEP when fixes came from constants, copy,
upstream values or features; SPLIT or REWRITE when they came from the
function's own branching or state. Do a small split in the same change.

## Kommunikationsdisciplin

1. **Prata bara när (a) en STÖRRE uppgift är KLAR, (b) du behöver
   feedback/beslut, eller (c) något blockerar mottagaren.** Inga "klar med X,
   fortsätter med Y"-status, inga kvittenser, inga artighetsfraser.
   Commits + ledger ÄR statuskommunikationen.
2. **Review och verifiering:** följ staffing-reglerna 6 och 7 nedan.
3. **Delade träd fryses i KORTA koordinerade gate-fönster** (en utsedd
   koordinator äger fönstret), aldrig dagar-långa blanket-fences av en
   annan panels yta.

## Staffing and review economics

1. **One owner per feature, end to end.** The direct recipient owns it;
   a capable idle agent may self-claim an explicitly claimable board ticket.
   The owner plans, builds, verifies, rebases, self-merges, deploys when needed
   and records the completion commit. Scope follows the full root-fix seam.
2. **Managers are sidecars, not gateways.** They act on a stall, collision,
   delivery failure or idle-capacity gap. Work, decisions, merge and delivery
   need no manager round-trip.
3. **Do not wake a fleet to look busy.** A durable task wakes its exact owner;
   dormant panes stay dormant. "Sync/check all panels" authorizes reading
   status and evidence, not prompting them. Even FYI or "no action needed"
   messages run a model and spend quota: store shared criteria for the next
   natural turn and contact only an owner who needs an action or
   handoff. An idle panel or unused provider is not permission to activate it.
   A pane back after 7+ days first re-anchors with
   \`amux done --week\`, \`amux asks --open\`, this policy and the repository's
   instructions. \`amux reconcile\` repairs service/shell panes; it is not a
   staffing command and never wakes coding agents. Delivery is proven by the recipient's durable
   receipt, not enqueue time; the owner-response clock starts at that receipt.

   Codex models (Mattias, 2026-09-20 and 2026-10-11): default
   \`gpt-6.1-sol\`, never Astra; Claude and Kimi keep theirs. A pane
   choice survives restart. Change models only with Discord \`/model sol\` or
   \`amux model PROJECT -p N sol\`: it compacts that exact session first and
   verifies the live model; a raw \`/model\` is refused. A failed compact blocks
   ordinary changes; explicit \`sol xhigh --new-session\` on a stopped pane
   preserves its old journal and starts fresh. Dormant panes switch at their
   next work prompt, never by a fleet wake-up. Read model, tokens and receipts
   from the exact pane. Quota is paid capacity.
   Codex account recovery switches only after a reached weekly limit, with
   verified room and exact-session transfer, or a saved fresh-session handover.
   Forecasts never switch accounts. \`AMUX_CODEX_LIMIT_RECOVERY_ENABLED=false\` disables it.
4. **Respect actual availability.** One active feature per agent. Never stack
   work on a pane that is working, in a modal, or between tool calls.
   A blocked task does not reserve its pane indefinitely:
   checkpoint it and release its active resources before taking independent work.
   Honor the project's configured concurrency limit; do not invent extra
   parallelism. A board lease alone does not prove a pane is free.
5. **A configured board is a shared work list, not an orchestration ceremony.** Keep the
   minimum durable facts: task, owner, state, blocker/reason, and completion
   commit or PR. Comments route to the current owner. Managers read the
   aggregate view; workers do not need a manager round-trip to claim, update or
   finish their own work.
6. **Merge by fresh proof.** Immediately before merge, fetch and rebase onto
   current trunk in the allowed checkout. On that exact source run fast
   changed-unit tests and lint, exercise the actual feature manually, and run
   one relevant local smoke lasting at most 5 minutes. Heavy CI,
   full-repo suites, browser matrices and perf sweeps run only on explicit
   human request or scheduled/manual infrastructure. A green pre-rebase check
   proves nothing. For visual work, exercise the smallest relevant visual
   scenario and attach one representative screenshot when useful. Preserve
   repo correctness and security requirements: never hide a real failure or
   add file-size exceptions to make a gate green. If a required check cannot
   fit this budget, report the constraint rather than claim unverified success.
   GitHub-hosted CI is optional evidence, never release authority; do not add
   a remote-CI or PR ceremony to a clean locally verified change. For deployment,
   follow the repo's existing local-first release contract for exact source SHA,
   rollback SHA, relevant build and live verification. Do not duplicate gates.
7. **Owners self-merge and self-deliver.** A normal green change does not need
   peer review. Human-requested review is welcome; a red gate or high-risk seam
   needs resolution, not an automatic peer-review loop.
   A merged-but-undeployed feature remains open when
   deployment is part of the task. Irreversible or money-spending actions still
   require human approval.
8. **Report only terminal outcomes.** Inter-agent messages are for a real
   blocker, collision, handoff or final DONE report, not acknowledgements,
   progress chatter or routine status. Commits, the board and the ask ledger
   carry normal progress.
9. **Record blockers where work is tracked.** Use a concrete reason and the
   dependency/evidence needed to clear it. Do not keep blockers only in a
   manager's memory, and do not call silence or an unstarted owner clock a
   worker failure. With a board, use its typed states, not prose in a private note.
10. **Human direction is authoritative and remains direct.** A decision relayed
    as authority (a GO, a price, a name) keeps the human quote byte-for-byte with
    provenance. A work brief is the orchestrator's interpretation: numbered
    executable steps, not the human's text (see the amux-orchestrator skill).
    No manager, memory note or older topology rule may narrow,
    delay or override a current direct instruction. Human language stays UTF-8
    end to end: preserve literal \`åäö\` and quoted text byte-for-byte. Board
    mutations containing human text use the canonical \`amux-suggest\` body-file
    and \`--expect-file\` path instead of lossy inline rewrites.
11. **Make reversible product calls yourself.** Pick the option best supported
    by the user's history, ship it, and explain the choice. Ask first only for
    irreversible, external-facing, money-spending or genuinely risky decisions.
12. **A drained backlog is healthy idle.** On DONE or BLOCKED, re-read the existing queue.
    Re-evaluate conditional deferrals against completed prerequisites.
    Take the next authorised independent READY item; a blocker holds only its
    actual dependents. Stay idle only when no authorised runnable work remains.

## Minnesloggning

- Dagfilssektioner är digests: använd täta bullets, inte löpande stycken.
- Max cirka 10 rader per manuell sektion. Flytta tekniska detaljer och
  återanvändbara how-tos till \`memory/references/\`, persondetaljer till
  \`memory/people/\`, och länka därifrån.
- Skriv allt viktigt, men duplicera inte samma status i flera sektioner.
  \`amux dream\` använder den synliga, konfigurerade kuratorpanelen. Gamla
  dagfiler mäts av lint men skrivs aldrig om av en dold modellprocess.
`;
