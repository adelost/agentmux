> AMUX 1.25.75 model and context-cost policy, its evidence boundaries, and operator recovery. Delivery evidence is tracked in TASKS.md.

# Authority and scope

Mattias, 2026-09-20: “detta gäller enbart våra codex paneler.. claude och kimi ska vara kvar”. He wants all current Codex panels selected for `gpt-5.6-sol`, while a later explicit model choice survives AMUX restart. Every model change must compact first. He then authorized the cost protection and documentation: “ok.. fixa detta åt mig.. och dokumentera tydligt också...”.

Subscription quota is paid capacity. Spending quota unnecessarily is a cost even when there is no separate per-token card charge. Never describe it as free.

The numerical thresholds below are the implementing agent's selected initial policy, not measured economic break-even points. The operator may revise them.

The executable decisions use Skyvw/CircleKit's existing `@v1d/product-spec` DSL in `policies/context-cost.mjs`: 18 context-cost combinations and 24 Codex-launch combinations. Declaration rejects missing/overlapping cells and forbidden outcomes. The existing sleep safety checks remain in their original controller. Evidence collection and provider effects still require separate verification.

# Model selection

- This migration selects Sol for the existing Codex panes. Claude and Kimi retain their engines and models.
- A later explicit pane model selection is durable. Restart resumes that selection and the exact session, without resetting it to the fleet default.
- A model change compacts the same session on its previous model, verifies a new compact boundary, then launches the selected model and verifies the live selection.
- Failed or unverified compact blocks the transition. Repeated delivery retries cannot repeat a failed paid compact automatically.
- A new work prompt cannot proceed on an unknown or different live Codex model.
- Dormant panes undergo the guarded transition when next needed. They are not all awakened merely to update a setting.
- Model, context tokens and compact evidence must belong to the exact pane. A newer parent-directory conversation is not evidence for a child pane.

# Context and sleep

1. Idle compact: after 10 minutes without work, above 150,000 tokens, using the existing daytime controller and safe-idle checks. A completed or failed attempt does not repeat until new work provides a new context generation.
2. Sleep: retain the existing 24-hour threshold and conservative process-exit conditions. Dirty worktrees may block process exit but do not by themselves block idle compact. Current sleep support is Claude-only; this change does not silently promise Codex/Kimi process sleep.
3. Cold wake: before a work prompt to a session idle at least 24 hours and above 150,000 tokens, require successful exact-session compact. Failure blocks automatic work and remains visible. A previously compacted, small session resumes normally.
4. Dream: remains a memory digest with nightly maintenance as an additional check. An unavailable delivery lease may be retried without consuming a paid model attempt. A compact already submitted with an ambiguous outcome is not blindly repeated.

The existing nighttime budget is 80,000 tokens after 30 minutes idle. That is a policy target, not a guaranteed compact output size.

Runtime overrides: `AUTO_COMPACT_MAX_TOKENS` (default 150000), `AUTO_COMPACT_MIN_IDLE_MS` (default 600000), and `AMUX_COLD_CONTEXT_IDLE_MS` (default 86400000). The nighttime job retries a busy shared lease twice, two seconds apart, before reporting a skip. These are lock checks, not model calls.

Warm/cold compact admission currently supports Claude and Codex. Kimi keeps its prior behavior; no new verified-compaction or sleep guarantee is claimed for it.

# Cost evidence

Elapsed idle time is a risk signal, not proof of an exact cache hit, miss or bill. The providers' actual usage records are the authority for observed cache use. Compaction itself can use paid quota, including a cold input context. It can lower subsequent context cost, but cannot guarantee a cheaper first interaction.

Do not claim that compact always adds exactly 80k tokens, that every cache has exactly a one-hour lifetime, or that every compact saves money. Large idle contexts are compacted as a bounded protective policy, not under such a guarantee.

`compacted-unmeasured` means the exact compact receipt was verified but the new token count was unavailable. It does not mean no compaction occurred. A missing `isCompactSummary` field alone does not disprove a Claude compact boundary.

The tmux delivery lease remains per session because pane delivery can zoom the shared window. Changing it to per pane without removing that shared effect is unsafe.

# Verification and recovery

Unit/component tests create synthetic log files or mock the process/provider boundary. They do not invoke a model, start real coding sessions or consume AI quota. Real `/compact` checks are separate and must name the pane and receipt.

Inspect `amux ps`, `amux queue`, and `amux doctor`. A selected/configured model is distinct from the model on the last recorded turn. A queued message is not yet a delivery receipt. A process start is not a successful model change.

Change Codex model with Discord `/model sol` or `amux model claw -p 4 sol` (an optional effort follows the model). Both paths use the session lease, exact compact receipt and live model verification. Raw `/model` delivery through `amux claw -p 4 "/model ..."` is refused, since Codex's native picker would bypass that contract and can persist account-wide settings.

Do not clear journals or delete delivery fences to recover a blocked transition. Resolve its reported cause, then retry the explicit model operation. Preserve the original session and pending request.

The parent-session regression failed before the fix: a 12k Sol pane was read as its parent's 181k Astra session, including the parent's compact receipt. The corrected reader passes both exact-pane and no-parent-fallback cases. The old daytime decision returned no action for 473k tokens at 56%; the updated decision starts the warning. The nightly lease-contention case failed before bounded retry and now performs one simulated compact after three lock checks.

The broad targeted pass comprised 311 tests in about two seconds. Subsequent changes were checked with their affected files; no full repository suite, remote CI, churn gate or real model call was part of automated testing.

Codex supports an explicit model override when resuming an exact session: [official CLI reference](https://developers.openai.com/codex/cli/reference#codex-resume). AMUX adds the compact and verification requirements above.
