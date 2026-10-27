# Gemini minimal delivery, task 112

Source: delivery:4d8f6025b303a971e96a9016754a9d67. Gemini CLI stopped serving
Google AI Pro and Ultra on 18 Jun 2026 (Google Developers Blog, "Transitioning
Gemini CLI to Antigravity CLI"); it now answers only paid API keys, which AMUX
must never use. The engine therefore runs the Antigravity CLI, `agy` 1.4.8, on
the operator's own Google login. The engine name stays `gemini` (config
`gemini: N`, Discord suffix `-gemini`). The first Gemini CLI build, bec8ce49, is
superseded by this retarget (api:0, 27 Oct, after Mattias asked api:0 to do it).

## Behaviour and boundaries

- Launch is always `agy --dangerously-skip-permissions` (YOLO, Mattias 27 Oct),
  under `env -u` for every Gemini/Google API-key and Vertex variable.
- agy has no start-time id flag. A fresh pane starts without one; agy records
  the conversation per workspace in `~/.gemini/antigravity-cli/cache/last_conversations.json`.
  A pane AMUX started before resumes that workspace's id with `--conversation <id>`
  and persists it. `--continue` is never used.
- First start in a new pane directory answers agy's workspace trust prompt with Enter.
- Intake receipt: the new `history.jsonl` row whose `workspace` is the pane
  directory and whose `display` is exactly the prompt, after a pre-submit cursor.
  Pasted long prompts are stored in full (measured 878 chars, 3 lines).
- Answers and busy use the existing tmux fallback. A configured Gemini pane uses
  the agy dialect even after the banner scrolls away. The echoed prompt is cut by
  its own text, because agy indents prompt and reply lines alike.
- AMUX never reads agy's credential files.

## Targeted seam map

| Seam | Proof | Risk / level |
| --- | --- | --- |
| Launch, trust prompt, exact resume, pane slot, receipt, tmux reply/busy | core/gemini-minimal.test.mjs, real agy capture in test/fixtures/agy-1.4.8-tool-turn.txt | money/sync, unit+component, 7 cases |
| Screen mirror and restart dedupe | core/gemini-tmux-mirror.test.mjs | sync/privacy, component, 1 case |
| agy work footer | core/dialects.test.mjs | unit |
| Real agy through AMUX code | test/gemini-agy-smoke.mjs | live, one subscription request, isolated tmux |

## Receipts, 27 Oct

- RED: the new tests run against bec8ce49's source: 7 of 7 failed.
- GREEN: 59 tests in the four focused files. 25 files touching the changed modules:
  287 passed, 9 failed; 8 of those fail identically on master e5eaf4a9
  (test/agent.test.mjs wording pins, test/codex-config-start.test.mjs Astra rule),
  the ninth was the agy footer case, fixed with the observed footer.
- Strict changed lint: 0 findings. Legacy caps only shrink (agent 1766, watcher 887).
- Live smoke `/tmp/amux-agy-smoke-jwHnS8`: 20.1 s, receipt accepted, screen answer
  `AGY_SMOKE_OK`, mirrored once, restart resumed conversation 3673345c with the
  earlier prompt on screen. Account tier shown by agy: Antigravity Starter Quota.
