# Gemini minimal delivery, task112

Source: delivery:4d8f6025b303a971e96a9016754a9d67. Superseding scope from api:0,
27Oct18:4xZ/19:0xZ: ordinary `~/.gemini`, OAuth selectedType guard, env-unsets,
exact session launch/resume, five-engine pane order, tmux answers and busy.
Journal reading is intake-only, explicitly authorized by api:0 after the reduction.
No profile subsystem, new hooks, reply journal reader or whole-engine audit ships.
The larger superseded work is separate: `feat/gemini-observation-extra`, `3dde8beb`.

## Small proof and boundaries

- Start guard unit/component proof covers API-key or missing configuration refusal
  before launch input, and OAuth acceptance. It never reads credential files.
- Exact launch UUID is durable pane state; resume never uses latest.
- Native root user posts alone acknowledge a prompt; `<session_context>` is ignored.
  #428's post-wake cursor refresh and submitted ambiguity fence include this engine.
- Answers/busy use existing `getResponseStreamWithRaw`/`isBusy` tmux fallback.
  A small screen mirror joins the existing posting path and persists dedupe.
- Native prompt identity is allowed for echo/mirror identity, not answer or busy.
- Accepted boundary from api:0: CLI can reload auth variables from `~/.env` after
  env-unsets. Selected `oauth-personal` is the agreed money guard, not a claim that
  every variable remains absent after CLI initialization.
- No live Gemini panel starts before Mattias logs in. Release/config is authorized;
  real-provider validation remains outside this change's cost-free fake turn.

## Targeted seam map

| Seam | Proof | Risk / level / measured time |
| --- | --- | --- |
| Normal-home guard, launch, count/slot, intake, tmux fallback | core/gemini-minimal.test.mjs | money/sync, unit+component,8cases <40ms body |
| Screen mirror and restart dedupe | core/gemini-tmux-mirror.test.mjs | sync/privacy, component,1case |
| Existing changed routing/cursor/renderer consumers | dialects, qwen-delivery, delivery-cursor, sync, jsonl-watcher, agent tests | existing, bounded targeted selection |
| Actual installed CLI producer to screen consumer | test/gemini-minimal-smoke.mjs | isolated tmux+synthetic HOME, fake generator, network denied |

## Receipts

- Initial RED19:04:50Z: module absent,1failed suite/no tests collected (178ms).
- Guard trip-wire19:12:42Z with OAuth condition disabled:2failed/6not selected;
  refusal assertion did not throw and launch passed the guard. Restored condition.
- Screen regression initially leaked `> HELLO_GEMINI` into reply. Small prompt-box
  boundary proof passed, then full screen case passed; reply quotations preserved.
- GREEN19:16:05Z:9cases/2files (1.08s wall,39ms test bodies).
- Actual CLI0.65 fake turn: `/tmp/amux-gemini-minimal-xdpcaA`,3.943s,
  accepted:true, source:tmux, answer:GEMINI_MINIMAL_OK, captured mirror once.
  Fake generator and blocked network enforce no real provider calls. No hooks.
- Strict changed lint15files/25symbols:0findings; diff check clean; churn check:
  no hotspot reflection due. Legacy caps only shrink (agent1767, watcher888).
- Expanded selection19:17:58Z:203passed/2failed in10files,2.16s. Both failures are
  pre-existing policy wording pins in test/agent.test.mjs. Source commit84f93644
  changed the authority and Source sentences; the tests still expect the old
  wording. Those docs, policy generator, skill and tests are byte-unchanged versus
  origin/master. Direct baseline assertion inputs also show both old pins absent.
  No failed test was skipped, weakened or described as passed. Gemini proof is green.

Final release identity, installed proof and claw:9 config are recorded in task112.
