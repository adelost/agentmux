> AMUX 1.25.77 model and context-cost policy, its evidence boundaries, and operator recovery. Delivery evidence is tracked in TASKS.md.

> Review status, 2026-09-20: R1's immediate lease rejection and misleading start message are corrected in 1.25.77. Two outstanding maintenance/reporting findings remain in [the source review below](#review-2026-09-20-outstanding-controller-and-reporting-gaps). This is not an independent end-to-end release sign-off.

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

Runtime overrides: `AUTO_COMPACT_MAX_TOKENS` (default 150000), `AUTO_COMPACT_MIN_IDLE_MS` (default 600000), and `AMUX_COLD_CONTEXT_IDLE_MS` (default 86400000). The nighttime job retries a busy shared lease twice, two seconds apart, before reporting a skip. Explicit model changes wait for the shared lease for up to six minutes. These are lock checks, not model calls. Warm, cold and nightly maintenance reuse the same context-generation fence; no new work means no second automatic compact. That last sentence is the intended guarantee, not a complete implementation proof: the post-lease recheck gap in R2 below remains open.

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

Live receipts on 2026-09-20: the three active Codex panes compacted and showed Sol in the native UI. Current context afterwards was ai:3 87,510 tokens, claw:3 105,613, claw:4 95,412. The remaining 31 panes were not awakened for testing. All 34 received a durable Sol selection; Mattias then explicitly requested Astra for ai:3 at 15:55. That later choice was completed after another verified compact, with native `/status` showing `gpt-6-astra xhigh` on the same session at 16:02. It is an intentional exception, not a fallback.

Codex supports an explicit model override when resuming an exact session: [official CLI reference](https://developers.openai.com/codex/cli/reference#codex-resume). AMUX adds the compact and verification requirements above.

# Review 2026-09-20: outstanding controller and reporting gaps

Initial source: `14e75257b24b40ea11c540657ed55d11c785222e` (1.25.76). Updated against `5de489ab939a924bb8b02c698acbf0ed3cb04f13` (1.25.77), which arrived during review. The newer commit repairs the initial R1 behavior but does not change `cli/nightly-compact.mjs` or `core/context-maintenance.mjs`; R2 and R3 still apply. This is reviewer feedback, not a new operator policy. Preserve the existing model-choice and compact-first requirements.

Evidence boundary: the review read the repository files below and exercised two source-extracted control-flow probes with injected observations, queue leases, state and compact results. The probes executed `runNightlyCompact` and its decision/reporting logic, not real tmux or a provider. Their desired contract assertions both failed on the reviewed flow. A full clone/test run was unavailable because the review container could not resolve github.com; source reads and this documentation update used the GitHub connector. No real compact, model switch, restart, queue cancellation or production change was performed. The live-receipt paragraph above remains the implementing agent's report, not an independent live observation by this reviewer. Raw operator transcripts and private prompt text are not reproduced here.

## R1: initial lease rejection corrected in 1.25.77; integration proof remains separate

**Historical finding, now corrected in source.** At `14e7525`, `runLockedCodexModelChange` in `core/codex-model-command.mjs` attempted the session lease once and returned `delivery-lease-busy` immediately. `handlers.mjs` announced `Compacting ...` before admission. Commit `5de489a` replaces the single attempt with `waitForCodexModelLease` and changes the message to say it is preparing and waiting for the session lock.

The new helper permits 360 checks with 1,000 ms waits between failed checks. Its added unit/component case checks two refused acquisitions followed by success. This addresses immediate rejection; it does not by itself prove the entire Discord/CLI model-switch sequence or durable recovery of a pending explicit request after bridge restart.

**Keep the correction narrow.** Preserve the session-wide lease while a writer can zoom the shared tmux window. Do not delete a live lease or enqueue a compact behind a lease held by the same operation. Recheck exact session, composer, work state and target after waiting. A lease retry is not permission to retry a provider call after ambiguous submit. The current wait is bounded polling, not a persisted model-command queue or a demonstrated fairness guarantee.

**Integration acceptance.** Hold the same session's lease, request a model change, then release it. Assert zero compact calls while waiting, exactly one admitted compact, one transition, exact-session continuity and live target-model verification. Exercise both CLI and Discord and a permanently busy lease. Explicit non-default selection must not subsequently be treated as an unwanted fallback. This reviewer has not executed that live acceptance path.

## R2: the shared compact fence is not rechecked after nightly lease acquisition

**Reproduced in an isolated source-extracted probe; still open in 1.25.77.** `runNightlyCompact` reads `contextMaintenanceAttempt(...)` before acquiring or waiting for the session lease. Its later `check()` rereads pane observations and the nightly receipt file, but not the shared context-maintenance fence. `beginContextCompact(...)` subsequently writes a new attempt over that shared record.

A valid interleaving is:

1. Nightly observes an eligible, idle exact session with no shared fence.
2. The session lease is busy. During that wait, another maintenance path completes compact and stores a `VERIFIED` shared receipt.
3. The lease becomes available. No new work occurred, the session/path/activity are unchanged, and the result remains above the nightly target.
4. Nightly proceeds to compact again instead of respecting the new shared receipt.

The probe used a synthetic 120,000-token session, an 80,000-token target, a first refused lease and a shared verified receipt written during the 2,000 ms retry wait. Observed: two lease checks and **one additional compact call**. Expected: **zero additional compact calls**. This does not claim that the production incident followed this interleaving.

**Recommended correction.** Re-read the current persisted shared fence under the acquired session lease, before writing an attempt or invoking compact. Make check-and-begin one serialized operation across warm, cold and nightly paths. A cached pre-lock decision is not sufficient. Review the analogous cached `prior` in `core/context-maintenance.mjs` rather than fixing only the nighttime caller. Preserve failed/ambiguous attempts and late-receipt reconciliation; do not retry merely because tokens remain above a target.

**Regression acceptance.** Add a repository-native test for the interleaving above, plus failed/ambiguous shared attempts appearing during the wait. All must avoid a second provider call. Confirm behavior when no new work occurs and when a genuine new context generation does occur. Use independent process/state instances where the production controllers cross a process boundary.

## R3: a failed shared attempt can disappear from the nightly unresolved count

**Reproduced in an isolated source-extracted probe; still open in 1.25.77.** The early shared-fence branch in `runNightlyCompact` treats every returned record alike. It appends only `status: "skipped"` and `reason: "compact-already-attempted-without-new-work"`, losing the attempt status, original reason and `beforeTokens`. The final `unresolved` filter does not recognize that reason.

The probe started with a same-session shared `FAILED` record, no new work and a synthetic 120,000-token context. Observed: **zero compact calls**, which is correct, but **`unresolved: 0`** and one generic skip, which hides the failed maintenance. Expected: no retry and a visible unresolved failure with its original cause. An `ATTEMPTING` record without a late receipt needs the same explicit unresolved treatment.

**Recommended correction.** Separate verified, failed and ambiguous shared receipts in reporting. Preserve session, before/after token evidence and the original failure reason. A verified earlier compact that remains above the target must be reported as such, not silently counted as within budget and not compacted again automatically. Keep retry prevention and successful completion as two different facts.

**Regression acceptance.** Assert correct reports and command exit behavior for a prior `FAILED`, unresolved `ATTEMPTING`, late-verified receipt and verified-above-target receipt. The first two must remain operationally visible without a new compact call.

## What this review retains

- Exact pane/session identity, compact-before-model-change ordering, durable explicit model choice, immutable installation identity and truthful compact receipts are the correct requirements.
- `policies/context-cost.mjs` now uses the shared DSL for cost/launch policy. The earlier description of DSL use as limited to repo hygiene and Link is superseded for these revisions.
- Exhaustive DSL cells do not prove lease scheduling, fresh observations, receipt reconciliation or actual rendering. These findings belong to the existing controller/state and reporting boundaries; they do not justify a language rewrite during incident recovery.
- Compilation, a successful installer and a smaller queue count are not end-to-end delivery or model-selection evidence. Keep release identity, running bridge SHA, exact compact receipt, live selected model and request acknowledgement as separately observed facts.

## Completion criteria for this incident

The operator's latest explicit per-pane selection is the target, not the earlier fleet migration default. Before reporting completion, bind the installed release and running heartbeat to the intended source SHA, verify the target model on the same session after the required compact, and establish the outcome of the already-pending request without replaying an ambiguously submitted prompt. Reuse existing receipts and passive observations wherever sufficient; additional quota-consuming proof is not authorized by this documentation review.

Status on `5de489a`: **R1 corrected in source; R2 and R3 OPEN.** This change records feedback only. Host recovery is reported by the implementing agent but is not independently verified by this review.
