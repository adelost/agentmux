# Qwen persistent-pane integration handoff

**Start here.** This is the execution handoff for the persistent Qwen integration.
For evidence and the detailed review, read [README.md](README.md).

## Decision

Keep Qwen as a **real persistent Qwen Code CLI inside the normal AMUX tmux/pane
lifecycle**.

Do not replace it with:
- direct Model Studio/OpenRouter API calls,
- a separate headless AMUX worker,
- a second broker/receipt owner,
- an AMUX-owned Qwen tool loop.

Qwen Code continues to own its provider authentication, Token Plan use, main/fast
models, subagents and tool harness. AMUX owns pane identity, delivery, observation,
routing and lifecycle.

## Current repository state

Merged before this corrective PR:
- #405: persistent Qwen panes
- #406: observed Qwen model/context in pane status
- #407: pane layout changed to Claude → Codex → Kimi → Qwen → services → shells

Open corrective PR:
- #409: `fix(qwen): isolate pane receipts and preserve long-session history`

The #409 branch is `fix/qwen-pane-receipt-isolation-20260922`.
Its corrective commit started at `42428474f41f3beea39205d23e7e8755118fdf3b`;
re-read branch HEAD before changing anything.

## Architecture invariants

1. The process in the pane is the real `qwen` CLI/TUI.
2. AMUX delivery stays in the existing durable delivery/broker path.
3. Qwen Dual Output is observation/receipt data for the same Qwen process, not a
   replacement agent runtime.
4. Qwen subagents remain enabled. Child events must not acknowledge or complete
   the root AMUX delivery.
5. Prompt receipts are bound to exact root session + process generation.
6. Recovery resumes the exact pane-owned Qwen session. Never use global
   “latest/continue” semantics as a fallback.
7. Corrupt existing continuity metadata blocks recovery. Never silently bootstrap
   a fresh session over ambiguous state.
8. Long-lived journals are read through bounded windows. File growth must not make
   the pane appear empty.
9. Provider/API keys remain Qwen-owned. AMUX does not copy or reimplement Token
   Plan credentials.
10. Do not reintroduce the experimental headless worker from #404 as production.

## What #409 fixes

- Old process-generation events could acknowledge/finish a newer root task.
- Foreign-session and subagent events could contaminate root completion/model truth.
- Journals larger than 16 MiB were treated as empty.
- Multiple public text blocks could share one watcher item ID.
- Malformed runtime metadata could be mistaken for “no prior session” and permit a
  fresh bootstrap.
- Stored event/input paths were not strictly bound to the declared generation.
- A configured `resumeSessionId` could be launched with fresh-session semantics.
- Pane cwd was not safely quoted when it contained spaces.

The detailed before/after evidence is in `before.json` and `after.json`.

## Verification already performed

Same 23 scenarios:
- baseline: 7 passed / 16 failed
- corrected: 23 passed / 0 failed

Scope:
- 19 scenarios exercise the complete reader against real temporary files and its
  real append-cursor/tool-display dependencies.
- 4 scenarios execute the complete runtime module with fake tmux and substituted
  command-builder/escaping collaborators.

This is targeted evidence only. It is not a full repository, installed-Qwen,
Discord or Token Plan test.

Offline reproduction:

```sh
node --experimental-vm-modules docs/reviews/2026-09-22-qwen-integration/verify.mjs
```

## Next agent: exact order

1. Re-read current `master`, PR #409 and this handoff. Do not assume the SHA above
   is still HEAD.
2. Run the normal focused repository tests with installed dependencies:

```sh
npm test -- \
  core/qwen-engine.test.mjs \
  core/qwen-integration-regression.test.mjs \
  cli/inspect-pane.test.mjs
```

3. Run the repository owner's existing changed-code lint/check path. Do not add a
   new CI gate just for this migration.
4. Compare the live/generated pane plan before any reconciliation. #407 means old
   service/shell indices may move behind Qwen. Verify labels, Discord mappings,
   orchestrator references and any running utility panes. Preserve live work; do
   not kill/restart it merely to obtain the new layout.
5. With the operator's normal authorization and existing Qwen Token Plan login,
   run **one small real Qwen pane journey**:

```text
AMUX addressed send
→ root Qwen prompt receipt
→ one harmless tool action
→ terminal/public answer
→ second prompt in the same session
→ exact restart/resume of that same session
```

6. If Qwen uses a subagent, verify:
   - child events remain visible/observable as appropriate,
   - child completion does not mark the root AMUX turn complete,
   - the reported pane model/context remains the root session's truth.

7. Only after steps 2–6 are green should #409 be marked ready and the Qwen pane be
   treated as safe for unattended repo work.

## Stop conditions

Stop and preserve state rather than retrying/restarting if any of these occur:
- ambiguous or missing exact session identity,
- corrupt runtime receipt,
- a prompt receipt is satisfied by another process/session/subagent,
- Qwen pane mapping does not match the intended repo,
- existing service/shell/Discord mappings would be destroyed by reconciliation,
- the installed Qwen event schema differs from the fixtures in a way that changes
  receipt/completion semantics.

Do not “fix” these by deleting Qwen history, runtime receipts, panes, project data
or user work.

## Remaining known boundaries

- The review did not independently rerun the full AMUX suite or strict lint.
- A real installed-Qwen/provider journey was not run by this reviewer.
- #407 deliberately changed the pane ordering contract. Treat migration of an
  already-running fleet as a separate verification concern.
- The existing interactive completion heuristic remains based on public assistant
  text/tool progression; no mandatory headless `result` event is invented.
- Quota dashboard, verified Qwen compaction and every fourth-engine lifecycle
  feature are not certified merely because send/reply works.

## Completion receipt format

When finishing, report only what is actually proved:

```text
DONE: <merged/fixed concrete result>
VERIFIED: <tests + live path actually run>
OPEN: <remaining unsupported/unverified boundaries>
```

Do not describe Qwen as fully production-parity unless Discord/Link, recovery,
context/quota and the actual installed harness paths being claimed have each been
verified.
