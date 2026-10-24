import { fleetPolicyFile } from "./fleet-policy-files.mjs";

// WHAT: Defines the every-turn fleet register. WHY: Keeps detailed rules demand-read without losing authority or provenance.
export const FLEET_PROCESS_HINTS = `## Verify before reporting

Don't claim "done/exists/complete" until 2+ methods agree, e.g. \`ls | grep\`,
\`Path.exists()\` and \`stat\` (WSL 9p mounts can lie). If they diverge: investigate.
Never skip a failing test or bypass a hook with \`--no-verify\`.

## Kommunikationsdisciplin

1. **Prata bara när (a) en STÖRRE uppgift är KLAR, (b) du behöver
   feedback/beslut, (c) något blockerar mottagaren, eller (d) en checkpoint
   uttryckligen har beställts.** Inga "klar med X,
   fortsätter med Y"-status, inga kvittenser, inga artighetsfraser.
   Commits + ledger ÄR statuskommunikationen.
2. **Delade träd fryses i KORTA koordinerade gate-fönster** (en utsedd
   koordinator äger fönstret), aldrig dagar-långa blanket-fences av en
   annan panels yta.
3. No skill names or bracketed labels in replies. Comments explain intent, risks or constraints, not a work diary. Preserve requirement scope and source pointers; never copy human quotations.

## Staffing and review economics

- One owner per feature owns it end to end, including required delivery.
- The allocator names READY owners once; owners then build and deliver without a manager round-trip.
- Do not wake a fleet to look busy; wake only the exact owner of authorised work.
- Respect actual availability: one active feature per agent, within the project's concurrency limit.
- TASKS is status; messages are DONE, concrete stops, decisions and requested checkpoints.
- Human direction is authoritative; current direct instructions outrank relayed decisions and older rules.

## Read when triggered

- Interpreting authority, relaying his words or making product decisions: read [authority.md](${fleetPolicyFile("authority.md")}).
- Before shared edits, a conflict or a commit: read [shared-edits.md](${fleetPolicyFile("shared-edits.md")}).
- Before handing work on, staffing, delegating or changing an account/model: read [handoff.md](${fleetPolicyFile("handoff.md")}).
- Claiming work, writing the ledger, or reaching DONE/BLOCKED: read [work-ledger.md](${fleetPolicyFile("work-ledger.md")}).
- Before a merge or release: read [merge-release.md](${fleetPolicyFile("merge-release.md")}).
- Before a compact or a long-running check loop: read [context.md](${fleetPolicyFile("context.md")}).
- Before changing a hot function: read [hotspots.md](${fleetPolicyFile("hotspots.md")}).
- Memory or day digests: read [memory.md](${fleetPolicyFile("memory.md")}); AMUX logs, Dream digests, workers keep no manual diary.
- Before health, quota or lifecycle maintenance: read [maintenance.md](${fleetPolicyFile("maintenance.md")}).
- Delivering images or speech, choosing a browser, or sending a notification: read [evidence.md](${fleetPolicyFile("evidence.md")}).
`;
