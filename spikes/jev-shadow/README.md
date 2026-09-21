# Experimental Jev shadow observer

**Status: standalone experiment, not part of AMUX's live router.** It classifies
one explicitly supplied text and suggests one candidate target. It never sends a
message, opens an app, starts/compacts an agent, changes a permission, or executes
an action. All outcomes say `NO_DISPATCH`.

Requested by the operator for testing. Added against agentmux
`1413687782c83305455efd2e98c0ca36994568be`, 2026-09-21.

## Run offline first

Node >=20, no installation or additional dependencies:

```sh
node spikes/jev-shadow/cli.mjs --demo
node --test spikes/jev-shadow/verify.mjs
```

The demo replays the **handwritten synthetic** `examples/response.json` through
the same response validator/report path. It is not a Jev inference, accuracy
result or latency benchmark. No key is needed. Merely setting a key does not
turn on networking.

Prepare the exact API payload locally:

```sh
node spikes/jev-shadow/cli.mjs --input spikes/jev-shadow/examples/input.json
```

Preparation prints the supplied message and candidate labels locally. It does
not send them anywhere. Read that payload before authorizing transfer of real
content. A custom JSON input uses the same small schema as `examples/input.json`:

```json
{
  "id": "my-test-001",
  "text": "Ask the code reviewer to examine the last change. Do not deploy.",
  "targets": [
    { "id": "ai:4", "label": "Code reviewer, referred to as fyran" },
    { "id": "ai:5", "label": "Performance analyst, referred to as femman" }
  ],
  "selectedTarget": "ai:4",
  "reference": { "intent": "agent_message", "target": "ai:4" }
}
```

Those target IDs are illustrative; the program does not discover or contact
panes. Supply only the candidates you intend to include. `reference` is an
optional caller-supplied comparison label, not verified ground truth, and is
**not sent to Jev**. The local request ID and target IDs are not sent either;
provider choices use `t0`, `t1`, etc., mapped back through a per-request snapshot.
The message and labels may themselves disclose information: there is no claim
that tokenized IDs anonymize them.

## One explicitly authorized real call

Set `TYPESAFE_API_KEY` in your local secret environment, never in a committed
file or command-line argument. Obtain an authorized TypeSafe account/key using
the provider's normal access process. This experiment does not provision an
account, buy credits, or enable a provider on your behalf.

```sh
# TYPESAFE_API_KEY must already be present in your local environment.
AMUX_JEV_ORIGIN=https://api.typesafe.ai \
  node spikes/jev-shadow/cli.mjs \
    --input spikes/jev-shadow/examples/input.json --live --allow-remote
```

`--live --allow-remote` explicitly opts into transferring this input's text and
labels to TypeSafe and making a potentially billable request. `AMUX_JEV_ORIGIN`
must match the official HTTPS origin exactly. No gateway, alternate URL,
redirect, local proxy or fallback provider is enabled. Shell proxy environment
or host/network configuration remains outside this module's control.

The CLI makes **at most one POST**, has a **5-second deadline covering headers
and body**, and performs **zero automatic retries**, including after 429/529.
A timeout or cancellation does not prove the provider stopped processing or
billing. Each new CLI invocation is a new experiment; the call limit is not a
persistent account-wide monetary cap.

Requests pin `jev-1.13.0`; a response naming another model is rejected. This is
an explicit reproducibility constraint, not a promise that the provider will
continue offering this version indefinitely. Re-read the official API and run
the contract/quality checks before changing the pin.

For offline replay of a separately obtained raw API response:

```sh
node spikes/jev-shadow/cli.mjs --input input.json --response response.json
```

The CLI's output is a sanitized shadow receipt, not a raw API-response capture.
It intentionally provides no automatic transcript or response-body archive.
Replay files must already be supplied by the caller; do not copy private
responses into this repository.

## Implemented boundary

```text
explicit JSON input (or a supplied transcript)
    -> validated request and frozen-in-time target mapping
    -> TypeSafe /v1/systemone (opt-in only), or offline response fixture
    -> validate pinned model, Choice distributions, Noul and usage
    -> shadow receipt / optional comparison
    -> STOP: no dispatch callback exists
```

Questions are deliberately small:

- `intent`: `agent_message`, `amux_command`, `computer_action`, `unknown`.
- `target`: one supplied candidate or `unknown` for missing/multiple recipients.
- `needs_reasoning`: a Noul observation, not a spending or permission decision.

Jev evaluates questions independently. No answer is assumed to condition another
question within the request. Multiple recipients or compound work are not
converted into a multi-agent delegation plan by this spike.

The report retains probabilities and provider confidence separately. Confidence
is a distribution-derived statistic, not proof a request is permitted or a
calibrated accuracy figure for Swedish AMUX input. No automatic threshold exists.
An explicit selected target is never overwritten by the suggestion; a conflict
is reported. An unknown or low-confidence result cannot run a command.

The live receipt includes request fingerprint, local request ID, model,
duration, attempt count and provider-reported input/output token usage. It
excludes input text, target descriptions, credentials and unrecognized provider
fields. Target IDs still appear locally for comparison. A SHA-256 fingerprint
is not anonymization and can be guessable for short known messages. There is no
background log writer.

Limits: 8 KiB UTF-8 text, 1..32 targets, 160 UTF-8 bytes per target label,
16 KiB input file, 32 KiB prepared request, 64 KiB response. Oversized input is
refused, not silently truncated into a different instruction. Probabilities
must name the exact supplied options, be finite and bounded, and sum to 1
within 0.001 rounding tolerance. Arbitrary model-generated shell text is never
accepted as an action.

## Placement and future integration

`channels/voice-input.mjs` already transcribes and delivers through the existing
broker/target path. `core/voice-transcriber.mjs` owns transcription. Neither is
changed here. Nothing imports this spike from startup, Link, the PWA, the
production CLI or a policy. There is no new `amux jev` command.

Jev 1.13 accepts **text**, not audio, screenshots or video. The Mac demo needs
separate speech capture/transcription and an accessibility adapter. This change
does not implement computer control or mid-sentence actions.

A later approved integration can call `createJevObserver` with explicitly
selected test inputs and compare receipts. Preserve the existing broker,
source/session identity, idempotency and policy owners. Do not let Jev's
classification establish permission, recipient authorization, a compact receipt
or consent. In particular, never auto-forward a partially transcribed utterance
just because a model is confident before the user finishes speaking.

The observer is disabled by default. Its optional `maxCalls` is shared by calls
to one instance, reserved before any await (including concurrent callers), with
failures still consuming an attempt. For repeated/fleet use, budget and
single-flight ownership must be integrated with AMUX's existing owner first.
Do not create independent counters per tag or use this spike as a new scheduler.

A fixed no-dispatch experiment does not need another decision-table engine.
CircleKit remains the deterministic product-policy owner; Jev observations
could later become validated inputs, never replacements for those laws.

## Verification receipt and limitations

Run on Node **22.16.0**: **67/67** explicit Node contract tests passed. These
exercise real request construction, response validation, CLI parsing/file
limits and the client using injected fake HTTP collaborators. There were **0
real TypeSafe calls** and no AMUX pane, provider, deployment or microphone
activity. The repository-wide suite was not run; production files are unchanged.

Coverage includes opt-in defaults, exact origin, request minimization, malformed
answers, probability/usage validation, budget reservation under concurrency,
header/body deadlines, cancellation, non-retry for 401/422/429/529, redacted
errors, selected-target conflicts, delayed input mutation and offline CLI paths.
A delayed-response test first caught an input-target mutation in the new
experiment; it was fixed by capturing the validated input before awaiting.
This was a local implementation issue, not a claim about an existing AMUX bug.

The tests do **not** establish model access, account quota, endpoint availability,
real latency, Swedish precision, or improvement over the existing orchestrator.
`--demo` is not a benchmark. Before any automatic routing, use held-out labeled
Swedish/English cases with unclear pronouns, similar target names, multiple
recipients, negation, quoted instructions and changed target order. Compare
mistakes and abstentions as well as latency/cost. A successful typed answer can
still choose the wrong option.

## API evidence (checked 2026-09-21)

Only official provider documentation was used for the adapter:

- HTTP schema and endpoint: https://docs.typesafe.ai/api
- Version, text-only input and language limitations: https://docs.typesafe.ai/models
- Confidence semantics: https://docs.typesafe.ai/confidence
- Known model limitations: https://docs.typesafe.ai/model-jaggedness/jev-1.13

The adapter uses built-in fetch instead of adding an SDK dependency or accepting
an SDK's automatic retries. All code/examples here are experimental; no vendor
claims of speed, accuracy or safety are treated as locally measured facts.
