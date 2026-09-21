# Qwen Code: bounded per-repository AMUX worker

Status: experimental but intended for direct operator testing. This adds an explicit
`amux qwen` command without changing the existing Claude/Codex/Kimi pane layout,
Discord routing, generated `agents.yaml`, running sessions or provider credentials.

Baseline reviewed: `adelost/agentmux@1413687782c83305455efd2e98c0ca36994568be`.

## What it does

- Projects the existing canonical `agentmux.yaml` into **one logical Qwen worker per
  canonical repository directory**. Directory aliases deduplicate. `qwen: 0` opts an
  alias out; missing `qwen` or `qwen: 1` includes it.
- Runs Qwen Code as one bounded headless turn using stdin + `stream-json` output.
- Creates the first session only with explicit `--bootstrap`, then resumes only the
  exact recorded UUID. It never uses `--continue`, “latest”, another repo or another
  worker's session.
- Records a durable pending receipt before spawn, serializes one owner per repo,
  refuses ambiguous retries, and replays already completed request IDs without
  calling the model again.
- Defaults to Qwen approval mode `auto`. `default`, `plan`, `auto-edit`, `auto`, and
  explicit `yolo` are accepted. No mode silently falls back to another one.
- Always excludes Qwen's `agent` and `list_agents` tools. AMUX remains the
  orchestrator, and nested Qwen fan-out cannot silently escape the top-level tool
  budget.
- Preserves terminal subtype/reason, bounded token usage and sanitized permission
  denial tool names. A run with permission denials is `completed_with_denials`, is
  persisted exactly once, and the CLI exits **2** rather than calling it a clean
  success.
- Works around the known Qwen headless false-success class where stream-json may
  return exit 0 and `subtype=success` with a result beginning `[API Error: ...]`.
  AMUX treats that as `QWEN_API_ERROR` and blocks automatic retry.
- `amux qwen --doctor` checks the actual executable's `--help` and `--version`,
  including the flags this adapter relies on. It does not prove login/provider
  availability and does not make a paid request.

This is not yet a fourth ordinary tmux pane engine. `amux <agent> -p <pane>`,
Discord/Link, quota UI, compact/recovery and the production watcher still own only
the existing engines. For that later integration, Qwen's Dual Output sidecar is a
better path than scraping the TUI prompt glyph.

## Before first real use

Qwen Code must already be installed and authenticated by the operator. AMUX does
not provision accounts, API keys or subscriptions.

```sh
amux qwen --doctor
amux qwen --plan
```

`--plan` is read-only. Verify that every repository you expect appears once and
that aliases map to the intended canonical directory. To opt a configured alias
out of the experiment:

```yaml
agents:
  some-repo:
    dir: ~/lsrc/some-repo
    qwen: 0
```

A `qwenModel` is optional. If omitted, the first Qwen run uses the model selected
by the local Qwen client; the actual model reported by the session is then pinned
for later resumes. A configured model cannot be changed underneath an owned
session without an explicit migration.

## Run one task

Use a local file so prompts are not shell arguments:

```sh
cat > /tmp/qwen-task.txt <<'TASK'
Read the relevant code first. Fix the small issue described below, run the focused
tests, and report exactly what changed. Do not deploy or change credentials.
TASK

amux qwen \
  --repo my-repo \
  --message-file /tmp/qwen-task.txt \
  --request-id qwen-test-001 \
  --execute --allow-provider --bootstrap
```

The first turn needs `--bootstrap`; later request IDs on the same repo resume the
stored exact session and omit `--bootstrap`.

Default limits are 40 session turns, 80 top-level tool calls and 600 seconds wall
clock. They can be reduced with `--max-turns`, `--max-tool-calls` and
`--wall-seconds`. Qwen nested agents are disabled, so the tool-call number is not
quietly multiplied by hidden subagents.

`--allow-provider` is deliberately required for each execution command because the
local Qwen configuration can send repository content to a paid/remote provider.
It is consent to this turn, not a spending guarantee. A timeout/cancel may happen
after provider work or filesystem side effects have already occurred.

## Outcomes

Clean completion:

```json
{
  "outcome": "completed",
  "sessionId": "...",
  "actualModel": "...",
  "permissionDenials": [],
  "usage": { "input_tokens": 123, "output_tokens": 45 },
  "replayed": false
}
```

Verified terminal result with blocked tools:

```json
{
  "outcome": "completed_with_denials",
  "permissionDenials": [{ "toolName": "run_shell_command" }]
}
```

That second case exits 2. It is not automatically resubmitted, because the model
may already have edited files before the denied operation. Reusing the same request
ID returns the stored receipt. A different request can be sent after inspection.

Pending/failed/unknown outcomes block new work for that worker until the exact
session/state is inspected. Crash locks are never stolen automatically.

State is kept under `~/.agentmux/qwen-code/<worker-id>/` with private permissions.
The current state schema is version 2. Old experimental receipts are refused rather
than silently upgraded because earlier drafts did not retain denial metadata.

## Verification

Focused local verification on Node 22.16.0:

```sh
node --test experimental/qwen-code/test/verify.mjs
node experimental/qwen-code/test/cli-entry-proof.mjs bin/agent-cli.mjs
```

Current result: **27/27** contract/worker tests and **9/9** real-entry scenarios.
The tests use a fake Qwen child and no provider/model call. They include exact
resume, idempotent replay, config opt-out, approval modes, hidden-subagent refusal,
permission-denial receipts, the upstream `[API Error: ...]` false-success case,
timeout/cancel, model mismatch, state permissions, and legacy AMUX CLI dispatch.

No full repository suite or real Qwen provider turn was run in this review
environment. A real `qwen --doctor` and one deliberately small real task are still
required on the operator's installed machine before calling the experiment proven
against that Qwen build/account.

## Why not add a normal Qwen pane yet?

AMUX currently models coding panes as a contiguous Claude → Codex → Kimi prefix,
followed by service/shell panes. Blindly inserting another count can shift existing
pane indices, labels and Discord destinations. Qwen also now exposes structured
Dual Output (`--json-file`/`--input-file`), so a production Qwen pane should use
that structured sidecar through the existing broker/watcher rather than imitate
Kimi screen scraping or keep this headless worker as a second competing owner.

This command is therefore a safe operator-facing bridge: useful now, but isolated
from fleet renumbering until the normal pane planner/broker has a Qwen-aware design.
