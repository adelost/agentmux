# Review: persistent Qwen AMUX integration

**Recommendation: retain the persistent Qwen CLI architecture, but apply the reader/continuity fixes in this change before relying on unattended delivery and recovery.** This is not a replacement harness or a return to experimental headless workers.

Reviewed 2026-09-22. PRs #405 and #406 are merged. Initial reading point was `93e810690022c8b12c593327c07f7f988d3a1939`; PR #407 arrived during review, moving master to `06dffc03b9caa2be626aa2767a7859ced5614ab9`. The two production modules fixed here are unchanged between those revisions. This change is based on the latter and preserves #407.

## What is correctly integrated

The actual launcher starts persistent `qwen` with an exact session and structured input/output files inside the existing pane lifecycle. AMUX uses its existing delivery fence, prompt-echo boundary and watcher dispatch. There is no new model HTTP client or tool-execution loop. The existing execution-policy module owns Qwen's `auto` setting; its subagent tools remain available. #406 correctly connects pane inspection to `getContextFromQwenJsonl`, instead of falling through an unsupported generic context-reader branch.

The complete diffs of #405, #406 and #407 were inspected, including pane planning, command/dialect recognition, launch, broker call sites, watcher dispatch, context and recovery. The Qwen reader and runtime modules, their focused tests, and relevant append-cursor/display dependencies were read in full. This is not a line-by-line audit of the entire repository.

## Reproduced findings and fixes

| ID | Finding before this change | Fix |
|---|---|---|
| Q1, high | Receipt and busy readers concatenated every generation's events and did not distinguish root, subagent or foreign-session messages. An old file appended after restart could acknowledge a new delivery or make the current task appear complete. A child answer could also replace the observed main model. | Active status/context fallback reads the published generation only and filters by exact session plus root envelope. Prompt cursors capture session/generation. Previously captured receipts remain readable in their original file after restart, but a replacement generation cannot acknowledge them. Subagent execution is unchanged. |
| Q2, high | `parseLines` returned an empty array once any journal exceeded 16 MiB. A valid newest turn, status and context disappeared even though the file continued growing. | Bounded head/tail reader. History honors a capped `tailBytes`; returned history declares truncation. Publication reads the initial handshake from a bounded head, not from the tail. Native session history remains available across process generations. |
| Q3, medium | Two public text blocks in one native assistant record had the same item ID, making them indistinguishable to watcher deduplication. | Keep the previous first-public-block ID and give later blocks stable distinct suffixes. Existing single-block identities are unchanged. |
| Q4, high | A malformed saved runtime receipt looked like a never-started pane. Startup could silently create a new session. Input paths in otherwise valid metadata were not bound to the declared generation. | Strict continuity reads at lifecycle boundaries refuse invalid existing metadata. Read-only observation may still return unknown. Input/event paths must exactly match the pane/generation. No metadata deletion or automatic history migration. |
| Q5, medium | `paneConfig.resumeSessionId` selected a UUID but was omitted from the boolean deciding `--resume`; without a prior receipt it became `--session-id`. The `cd` prefix also failed to quote a directory containing spaces. | One resolved resume ID controls both continuity flags. The working directory is shell-quoted with the existing escaping helper. |

These are synthetic reproductions against actual source modules, not claims of observed damage in the operator's fleet. Probability, economic model quality, provider/account quota and actual deployed authentication are outside these tests.

## Numbering changed during the review

Do not keep repeating #405's promise that *every* old physical index remains fixed. Merged #407 explicitly changes the layout to Claude, Codex, Kimi, Qwen, then services and shells. Its PR body describes this as an operator-requested clean numbering and excludes old Kimi/Qwen history migration. That body is the implementer's account, not independent verification of the local migration or authorization.

This review does not revert the layout or touch the active config. Before deployment/reconciliation, compare the actual old/new pane identities, labels, channel mappings and running utility processes. In particular, services/shells can move, and a Qwen pane formerly after them changes its physical index and hence pane-state directory. The unlabeled mixed-layout unit fixture does not prove a labeled, running fleet has been safely migrated. Preserve/resolve existing live work before any such change. Do not kill it to make the generated layout match.

Also note the existing parser's shorthand: adding `qwen: 1` to a category that relied on implicit default Claude can turn that default off. Explicit engine counts avoid this ambiguity. That syntax/policy question is not changed in this reader-focused PR.

## Evidence

The unchanged baseline reader (`3e8505a2b9d27b6722426eb8bf4dea4b99206177`) and runtime (`fe555d9144e85ddeda101d79cdbee12e853be2d8`) were reconstructed from connector content and checked with Git blob hashes before testing.

The **same 23 scenarios** were run before and after: **7 passed / 16 failed before; 23 passed / 0 failed after**. Those are scenario counts, not 16 independent bugs. Nineteen scenarios exercise the complete reader with real temporary files and its real append-cursor/display dependencies. Four execute the complete runtime module with fake tmux, a recording command builder and an escaping collaborator; they prove lifecycle decisions, not a working installed Qwen process. Raw results are [before.json](before.json) and [after.json](after.json).

The normal repository test entry `core/qwen-integration-regression.test.mjs` uses the same scenario functions with the actual runtime/launcher imports. It was added but **not run under bdd-vitest here**: this environment lacks the repository dependencies and external DNS failed. No full Vitest suite, strict lint runner, live tmux/Qwen, Discord or Token Plan call was executed. Builder-reported 268/37/87 focused-test counts and earlier live runs in PR descriptions are not my reruns.

Offline reproduction from repo root, Node 22 used here:

```sh
node --experimental-vm-modules docs/reviews/2026-09-22-qwen-integration/verify.mjs
```

The optional positional argument selects another local source checkout for before/after comparison. The scenario files remain the same. This runner's explicit VM collaborators are only for the four lifecycle cases; it does not substitute the Qwen reader under test. It never installs packages, launches a model, opens a microphone, connects to tmux or reads the operator's Qwen state. It deletes only its own temporary fixtures.

Repository-owner verification after applying:

```sh
npm test -- core/qwen-engine.test.mjs core/qwen-integration-regression.test.mjs cli/inspect-pane.test.mjs
```

Run the owner's existing changed-code lint and integration checks too. No new policy gate, relaxed assertion or baseline exemption is introduced.

## Remaining live acceptance boundary

Keep the actual Qwen harness and provider settings. Prove one ordinary addressed AMUX turn, a tool action, a follow-up in the same session, root/subagent attribution when delegation occurs, and exact resume. Confirm the active status and mirrored answer belong to the right root session, and check the real fleet mapping after #407. Do not interpret a successful mock test as approval to restart all panes or spend on automated test prompts.

The existing completion heuristic still distinguishes assistant text from tool-use messages; this PR does not invent a mandatory headless `result` event for the interactive protocol. Error/control-event handling, sidecar failure and a manually replaced live process need the owner's real-version acceptance traces. A persisted handshake is not proof that the same PID is still alive. This review does not certify quota dashboard, verified compaction or complete fourth-engine parity.

## Scope preserved

Only Qwen's journal read/identity logic, its small lifecycle corrections, regression cases and this review are changed. No live config, pane order, other-engine implementation, Qwen tool exclusions, fast-model routing, provider endpoint, credential, deployment or running process is changed. There are zero real model calls in the review.

Qwen protocol references: official Dual Output documentation at https://qwenlm.github.io/qwen-code-docs/en/users/features/dual-output/ and `QwenLM/qwen-code@7837c6c200afb3853a126fc2dc01a155204aaaed`, `packages/cli/src/dualOutput/DualOutputBridge.ts`. These support the sidecar/harness distinction and capability handshake, not claims of successful integration on the operator machine.
