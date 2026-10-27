# Gemini engine build map

Spec: `/home/adelost/lsrc/.artifacts/gemini-amux-20261027/PLAN.md`.
Source: delivery:4d8f6025b303a971e96a9016754a9d67, delegated by api:0.
Builder: api:6. Branch: `feat/gemini-engine`, base `e5eaf4a9`.

## Estimate before code

8–12 working hours, excluding operator Google login and the release queue.
About 30–40 existing production files plus 5–7 small production modules/scripts,
6–9 focused test files and this evidence. Inventory is provisional until the engine
branch audit is complete, not a promise to edit every engine-specific module.

- 1.5–2h: installed-CLI fake TUI probe, launch/profile safety and durable hooks.
- 2–3h: bounded reader, exact identity/generation, receipt and restart lifecycle.
- 3–4h: config, agent, watcher, CLI, history and explicit unsupported routes.
- 1.5–3h: focused regression proof, fake full journey, lint/churn and self-review.

Test authoring/updating budget <=2h. Final targeted run including one fake smoke
<=300s; split by seam if measurement requires it. No full suite or real model calls.

## Plan versus current source, before code

1. Source `core/runtime-account-profiles.mjs` has no Gemini provider/catalog.
   A profile selector is missing from the plan. Proposed: explicit `geminiProfile`
   login in source config, resolved only below the declared Gemini profile root;
   absent/unknown profile refuses launch, never falls back to `~/.gemini`.
2. The six `env -u` entries do not cover CLI's `GEMINI_CLI_AUTH_OVERRIDE`, which
   overrides selectedType. Also CLI loads workspace/ancestor/profile `.env` after
   launch. Removing inherited keys alone does not prove keys stay absent.
   Source: installed0.65 bundle `chunk-ROYQ3K4N.js:16555–16665,16779–16829`.
   The build must guard the effective environment and settings, including override
   and local-env loading, without reading real credential or login files.
3. `GEMINI_CLI_HOME` is a synthetic home and storage is its `.gemini` child
   (`chunk-DKZARV6U.js:252011`), but the CLI's memory-relaunch wrapper reads
   `<GEMINI_CLI_HOME>/settings.json` (`bundle/gemini.js:25–26`). Use the actual
   storage path for auth/hooks; verify the fake TUI with relaunch disabled so it
   cannot accidentally read the wrong settings. Do not duplicate login files.
4. Existing bulk/targeted `amux compact` accepts all registered dialects, so adding
   Gemini to ALL_DIALECTS alone violates the phase1 compact exclusion. Add an
   explicit compact capability/gate; preserve existing engines' behavior.
5. Qwen submits through its dual-output input file. Gemini's hook protocol is
   observation-only; its submit must use the existing durable TUI delivery fence,
   not copy Qwen's structured-input branch. #428 cursor refresh and no resend
   after ambiguous submit must apply to the new cursor kind as well.
6. No disagreement found in five-engine ordering. The stale comment in sync.mjs
   still says Qwen follows utilities; actual source and #407 put utilities last.
   The pilot/config is not changed in this build.

## Seam map and tests

| Production paths | Focused proof | Guards / level | Write min | Run seconds |
| --- | --- | --- | --- | --- |
| gemini launch/profile policy, agent-launch-command, execution-safety | core/gemini-launch.test.mjs | money/access: OAuth only, forbidden environment, safe quoting, explicit bootstrap/resume; unit/component | 20 | 2 |
| gemini hook script and runtime receipt files | core/gemini-hooks.test.mjs | sync/privacy: exact generation/session/path, malformed metadata fails closed, durable append; component | 15 | 2 |
| gemini-jsonl-reader and bounded window helper | core/gemini-reader.test.mjs | sync/privacy: context prefix ignored, exact root/generation, stable distinct IDs, long tail, no private thoughts, absent AfterAgent falls back; component | 25 | 4 |
| gemini-agent-runtime and agent launch/submit/restart wiring | core/gemini-runtime.test.mjs | access/sync: real fence, configured and persisted exact resume, no fresh start over corrupt receipt, effective-child guard before process; component | 20 | 4 |
| sync, source-pane-plan, pane-dialect, dialects, default-engine | core/gemini-engine.test.mjs plus existing sync/dialect/default tests | sync: indices/channel routing, native refusal, model Auto and explicit model, measured TUI readiness/modal detection; unit/component | 15 | 6 |
| agent, prompt-echo, delivery-cursor, submitted-tui-recovery | core/gemini-delivery.test.mjs plus core/qwen-delivery.test.mjs | sync: post-wake cursor refresh, wrong generation never ACKs, ambiguous submit never resent; component | 15 | 5 |
| alternate-session-reader, context, pane-activity, delivery-memory-context, dream-history, dream-summarizer, jsonl-watcher, CLI inspect/log/revive/restart-ready/stop-recovery/tmux/commands/state-age, unmapped-channel, reminders | nearest existing sibling tests plus Gemini route fixtures | sync: actual Gemini read/watch/identity dispatch, no Claude fallback; unit/component | 5 | 30 |
| compact, account/maintenance/quota/wind-down routes | core/gemini-engine.test.mjs plus affected compact/maintenance siblings | money/access: Gemini unsupported paths do nothing/refuse explicitly; unit/component | 5 | 15 |
| final composed local path | test/gemini-fake-smoke.mjs (manual named journey) | installed0.65 real TUI, addressed delivery, harmless tool, follow-up, exact resume, captured mirror; isolated tmux, fake responses only | included above | <=180 |

Existing Qwen review regressions remain in the focused selection. Every new
requirement gets a recorded failing receipt before implementation. Fixture imports
that fail before a new module exists are reported honestly as import reds, not as
individually executed cases.

## Hardest case and stop boundary

First prove the installed0.65 TUI starts and produces the intended hooks/journal
with fake responses and an isolated synthetic home. No real credentials, API keys,
Google login, live pane, bridge restart, release or active config change. No Gemini
process starts with GEMINI_API_KEY. Probe only its own tmux socket and cleanup only
its own processes. If fake TUI requires real auth or produces incompatible receipt
semantics, stop the dependent runtime work and report the exact evidence.

## Receipts

- 17:59:45Z launch tests RED: 1 failed suite, no cases collected, new module absent (390ms).
- 18:01:38Z hook tests RED: 6/6 failed, new script absent (346ms). The first draft had five false-positive negative cases; asserting the hook rejection marker made all six red before implementation.
- 18:04:02Z regression RED: 3 failed / 7 passed. Unsupported `--ignore-env` argv and missing supported `advanced.ignoreLocalEnv` guard. Removed flag, required setting.
- 18:07:55Z effective environment RED: 2 failed / 5 passed, SessionStart environment attestation absent. Hook now records presence booleans only.
- 18:08:01Z GREEN: launch10 + hooks7 = 17 passed / 2 files (577ms).
- Fake TUI stop1: `/tmp/amux-gemini-fake-fh9rZo`, unsupported argv, no turn (30.224s). Stop2: `/tmp/amux-gemini-fake-66ife3`, CLI's no-display OAuth branch despite fake generator, no turn (30.038s). Smaller source-backed display preflight passed2/2 (`/tmp/amux-gemini-fake-INDM7J`). Stop3: `/tmp/amux-gemini-fake-QutvN8`, invalid fixture theme label `Default Dark`, actual ID `Default` (30.791s). SessionStart did attest all forbidden variables false. Replan: separate source-backed display + theme preflights before another composed run, fail early on a known startup modal. No real login/credentials or model calls. Network blocked in fake subprocesses.
- First strict lint: 8 contract-comment findings, corrected to repository active-verb/boundary form. No lint rules changed.
- 18:11:48Z pane-files RED: 1 failed suite, module absent, no cases collected (174ms). 18:12:50Z GREEN: launch10 + hooks7 + continuity10 = 27 cases / 3 files (620ms).
- Fourth probe `/tmp/amux-gemini-fake-Z8kuOm` reached the composer but the immediate Enter was swallowed, draft remained untouched (20.043s). Source `agent.mjs` already settles short writes for1000ms. Replanned to the existing transport contract, with a composer-only smaller proof first: `/tmp/amux-gemini-fake-cD1HY3`, success4.335s. First actual fake turn: `/tmp/amux-gemini-fake-td7T3X`, success6.493s, one SessionStart/BeforeAgent/AfterAgent, expected public answer. This is not yet the addressed broker/tool/follow-up/resume/mirror journey.
- Synthetic ancestor dotenv negative control `/tmp/amux-gemini-fake-rUQ1tb`, success5.255s: ignoreLocalEnv=false gives effectiveGoogleApiKey=true in the actual SessionStart child environment. The planted value is deliberately not a Gemini API key and is never printed. Production start policy does not admit this negative-control configuration.
- api:0 approved explicit geminiProfile, effective environment/settings guards, ordinary TUI fence and compact capability, then corrected PLAN§3 to omit unsupported `--ignore-env`.
- Synthetic ancestor dotenv positive: first harness attempt `/tmp/amux-gemini-fake-E2vZJv` failed because a visible composer preceded the asynchronous SessionStart write. Saved SessionStart itself has all13flags false. Fixed harness readiness to await both, as the production runtime must. `/tmp/amux-gemini-fake-kHbfty` success4.943s: ignoreLocalEnv=true, effectiveGoogleApiKey=false. This and the negative control use only generated fixtures, a blocked network and fake generator; no real login files or paid keys.
- Foundation strict changed lint: 3 production files / 10 symbols, 0 findings. Diff check clean; churn: no hotspot reflection due. Full engine wiring and final journey remain open, this checkpoint is not a completed engine.
