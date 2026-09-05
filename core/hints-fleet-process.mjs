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

Rules live in exactly one layer; a rule restated across layers WILL drift,
and the stale copy becomes a trap. When you meet a duplicate, fix the
split instead of obeying the older text.

1. **This file (amux layer):** fleet process: dispatch, ownership, merge
   and review policy, communication discipline, memory logging. Synced
   into every project by amux; edit it in the agentmux repo, never
   per-project.
2. **An optional work-board integration:** when the current repository exposes
   its own workflow/API documents, those documents own ticket states and wire
   mechanics. If no board is configured, every board-specific rule below is
   simply inapplicable; AMUX core never assumes one exists.
3. **Each code repo:** its own truths (data provenance, gates, commands,
   deploy contracts) in the repo's \`AGENTS.md\` and linked docs. Repo
   and workspace checkout restrictions remain authoritative; this template
   does not override them or the user's current instructions.

## Always lead with a recommendation

When presenting options or asking "what should we do?":

- **Don't** defer with "let me know which you prefer" / "up to you" / "whichever"
- **Do** pick one and give a one-line reason tied to the user's history/goals
- Template: \`→ Rekommenderar B. Varför: [specific tie-in]\`
- In doubt: still pick, then add "säg till om du vill ha sanity check"

Drift-prone: the rule sits in system-context but attention weights tunnas
after many turns. The bridge's drift-guard sends you a \`[drift-guard]\`
reminder roughly every 40 turns (or after a /compact). When you get one,
re-read this section before responding.

Manual refresh: \`amux remind <agent> -p <pane>\` (or \`--all\` / \`--stale\`)
if you catch another pane drifting from this rule.

## Root cause > symptoms

Always fix the cause, not the symptom. Before patching, ask *why* it's happening.

- ❌ Test fails → skip the test
- ✅ Test fails → is the test wrong, or the code?
- ❌ Hook blocks commit → \`--no-verify\`
- ✅ Hook blocks → why? fix the underlying issue
- ❌ Error in prod → wrap in try/catch and swallow
- ✅ Error in prod → trace the path, fix the source

Quick workaround is OK when deliberate (time pressure, experiment), but
**call it out**: "patching surface, root cause is X, fix later."

## Verify before reporting

Don't claim "done/exists/complete" until you've verified with 2+ methods.
Especially on WSL 9p mounts where \`Path.exists()\` can lie. Combine e.g.
\`ls | grep\` + \`Path.exists()\` + \`stat\`. If answers diverge: investigate.

## You share this repo with other agents

Multiple panes may be committing to the same repo in parallel, and so are
past-you (from prior sessions). Git log is the ledger of who did what;
treat it as your first source-of-truth when observing unexpected state.

Before claiming "bug/race/data-loss" on any state anomaly:

- \`git log --since="<timestamp>" --oneline\` FIRST. Intentional commits
  explain most "anomalies".
- 2 signals (timing + magnitude) does NOT prove causation. Test against
  git-timeline before hypothesizing.
- \`grep\` commit-messages for keywords from the observed change.

If a commit explains the anomaly → case closed, no bug. If no commit
explains it → then consider race / data-loss hypotheses.

Concrete pattern: a dedup commit landing between two deploys explains
a "video count drop" without any race condition. Skipped git log +
investigation spun up = noise to the user, wasted agent time.

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
   already exist there. Same minor twice (e.g. two 1.16.2 commits)
   confuses downstream tooling.

Commit + push within 30 min of starting an edit. Long-running WIP that
isn't in git is invisible to other agents.

For missing dependencies in an authorized checkout, follow the repo's setup
instructions; \`amux --help\` documents \`worktree-deps\`. Bootstrap success
does not replace the scoped verification in staffing rule 6.

## Kommunikationsdisciplin

1. **Prata bara när (a) en STÖRRE uppgift är KLAR, (b) du genuint behöver
   feedback/beslut, eller (c) något blockerar mottagaren.** Inga "klar med X,
   fortsätter med Y"-status, inga kvittenser, inga artighetsfraser ("tack för
   bra jobb"). Commits + ledger ÄR statuskommunikationen.
2. **Review och verifiering:** följ staffing-reglerna 6 och 7 nedan.
3. **Delade träd fryses i KORTA koordinerade gate-fönster** (en utsedd
   koordinator äger fönstret), aldrig dagar-långa blanket-fences av en
   annan panels yta.

## Staffing and review economics

1. **One owner per feature, end to end.** A direct human request makes its
   recipient the owner. When a work board is configured, a capable idle agent may also self-claim one READY
   or otherwise explicitly claimable ticket. No broker relay or peer
   approval is required. The owner
   plans, implements, runs targeted checks, rebases, self-merges, deploys when
   applicable, verifies live, records the completion commit, and cleans up.
   Feature scope follows the full data-to-consumer seam when that is needed for
   a real root fix; it is not restricted to one pre-listed file.
2. **Managers are sidecars, not gateways.** A project manager watches capacity,
   blockers, dropped work and duplicate effort. It may nudge or reassign only
   after a concrete stall, collision, delivery failure, or idle-capacity gap.
   Normal tasks, decisions, reviews, merges and deploys do not flow through the
   manager. Do not make every worker report through one pane.
3. **Do not wake a fleet to look busy.** A durable task wakes its exact owner;
   otherwise dormant panes stay dormant. A pane returning after seven or more
   days first re-anchors with \`amux done --week\`, \`amux asks --open\`, this
   generated policy and the repository's current instructions before acting.
   \`amux reconcile\` repairs configured service/shell panes; it is not a
   staffing command and must not be used to wake idle coding agents.
   Delivery is proven by the recipient's durable receipt, not by enqueue time;
   the owner-response clock starts only after that receipt.
4. **Respect actual availability.** One active feature per agent. Never stack
   work on a pane that is working, waiting, blocked, in a modal, or merely
   between tool calls. Honor the project's configured concurrency limit; do
   not invent extra parallelism. A board lease alone does not prove a pane is
   free.
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
   worker failure. When a board is enabled, use its typed states rather than
   encoding state as prose in a private note.
10. **Human direction is authoritative and remains direct.** If relaying is
    genuinely necessary, preserve the human quote byte-for-byte and include
    provenance. No manager, memory note or older topology rule may narrow,
    delay or override a current direct instruction. Human language stays UTF-8
    end to end: preserve literal \`åäö\` and quoted text byte-for-byte. Board
    mutations containing human text use the canonical \`amux-suggest\` body-file
    and \`--expect-file\` path instead of lossy inline rewrites.
11. **Make reversible product calls yourself.** Pick the option best supported
    by the user's history, ship it, and explain the choice. Ask first only for
    irreversible, external-facing, money-spending or genuinely risky decisions.
12. **A drained backlog is healthy idle.** Do not invent scope. Sleep or leave
    unused panes alone until a real task targets them.

## Minnesloggning

- Dagfilssektioner är digests: använd täta bullets, inte löpande stycken.
- Max cirka 10 rader per manuell sektion. Flytta tekniska detaljer och
  återanvändbara how-tos till \`memory/references/\`, persondetaljer till
  \`memory/people/\`, och länka därifrån.
- Skriv allt viktigt, men duplicera inte samma status i flera sektioner.
  \`amux dream\` använder den synliga, konfigurerade kuratorpanelen. Gamla
  dagfiler mäts av lint men skrivs aldrig om av en dold modellprocess.
`;
