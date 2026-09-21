# Qwen AMUX handoff

## Current status

The bounded `amux qwen` path is ready for one operator-controlled real smoke test.
It is still intentionally separate from the normal tmux pane/broker engine.

Baseline: `agentmux@1413687782c83305455efd2e98c0ca36994568be`.

### Closed in this pass

1. **Headless permissions:** default changed from interactive `default` to Qwen
   `auto`; all five documented approval modes are explicit, including opt-in
   `yolo`.
2. **Hidden subagent budget:** launcher always excludes `agent` and `list_agents`,
   and the reader fails closed if a nested event appears anyway.
3. **Result truth:** permission denials, usage and terminal metadata are preserved;
   denial completions are visibly `completed_with_denials` and return CLI exit 2.
4. **Qwen upstream false-success:** `[API Error: ...]` inside a nominal successful
   stream-json result is rejected rather than persisted as success.
5. **Config meaning:** `qwen: 0` is now a real opt-out; missing/1 means one worker.
   `qwenModel` beside `qwen: 0` is rejected as contradictory configuration.
6. **Executable contract:** doctor checks both `--help` and `--version`, plus
   `--exclude-tools`; it reports the discovered version without claiming login.
7. **State compatibility:** schema bumped to v2 so receipts from the earlier draft,
   which discarded denial metadata, cannot be replayed as clean completions.

Focused tests: 27/27 plus 9/9 actual CLI-entry scenarios, no provider calls.

## Operator smoke-test order

```sh
amux qwen --doctor
amux qwen --plan
```

Verify the plan. Then run exactly one small disposable/reversible task in one repo
with a unique request id. Do not start with a deployment, destructive migration or
large multi-repo task. Inspect `outcome`, `permissionDenials`, `actualModel` and
`usage` before scheduling another request.

If doctor is red, capture only its sanitized JSON result and the output of
`qwen --version`; do not weaken required flags. If the real session emits an unknown
event, keep the exact Qwen version and add a bounded fixture from that public schema
before changing the parser.

## Remaining work for full fourth-engine parity

The next product change is not more headless code. It is a normal Qwen pane through
AMUX's existing broker/watcher while preserving every existing pane index.

Preferred transport: Qwen Dual Output (`--json-file` or an extra fd for events,
plus `--input-file` for commands) alongside the interactive TUI. Do not run a
headless worker and a TUI worker against the same session.

Required before full parity:

- Refactor the pane plan only enough to represent Qwen without renumbering existing
  service/shell destinations. Verify mixed Claude/Codex/Kimi/service/shell layouts.
- Add Qwen runtime/session observation from structured events, not prompt-character
  guessing. Exact session/process generation remains mandatory.
- Route delivery through the existing durable broker/idempotency owner. Remove or
  retire this experiment's private receipt owner for any target migrated to the
  broker; never leave two writers.
- Decide Qwen compact/context/quota support from real Qwen evidence. Unknown stays
  unknown and unsupported operations refuse explicitly.
- Integrate Discord/Link/revive/restart only after one ordinary local Qwen pane
  passes a send → tool work → terminal receipt → resume journey.
- Keep authentication/model provider client-owned. Do not copy Qwen tokens into
  AMUX account stores just for symmetry.

## Review caveats

No actual Qwen binary/provider was available in this execution environment. The
adapter was checked against current Qwen public documentation and fake-child
transport tests. The operator machine must still prove its installed version and
account with `--doctor` plus one real bounded task.

Do not merge claims such as “full Qwen engine”, “Discord-ready”, “quota-aware” or
“fleet deployed” from this patch. The accurate claim is: **one robust bounded Qwen
worker per configured repo is available through explicit `amux qwen` execution,
without modifying the existing fleet.**
