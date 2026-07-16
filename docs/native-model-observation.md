# Native model observation contract

> **Why:** Native Claude/Codex sessions must expose and react to the model the engine actually served, without overwriting the model the user requested.

## State model

- `model` / `requestedModel` is mutable user intent. A change applies to the next turn and never creates a new Claude session or Codex thread.
- `observedModel` and `observedEffort` are engine evidence from the latest turn.
- `modelObservation` records the evidence source, observation time, turn id when available, and the immutable requested settings used to start that turn.
- `modelGuard` is a derived safety hold. It exists only when the shared model-watch policy classifies an unexpected requested-to-observed divergence as a model downgrade.

The requested model is never replaced with an observed fallback. That separation makes a silent fallback visible instead of converting it into the new desired configuration.

## Evidence sources

- Claude: `assistant.message.model`, with the single `result.modelUsage` key as a fallback.
- Codex: newest `turn_context.payload.model` in the exact session JSONL. The runtime also consumes the official app-server `model/rerouted` notification.
- Synthetic Claude messages and Codex session-head defaults are not model-change evidence.

Aliases such as `fable` and `opus` match their full Claude model identifiers. Unknown aliases are not guessed.

## Transition and safety policy

`core/model-watch.mjs` remains the only classifier for upgrade, lateral change, and downgrade. Native runtime events carry that result to both code.v1d.io and the Discord watcher.

- Every observed transition emits `web:model-change` and, for an agentmux-bound pane, an append-only `model_change` fleet event.
- Requested switches are visible but allowed.
- Automatic lateral frontier changes such as Fable to Opus warn but continue.
- Automatic downgrades interrupt the current turn, set `modelGuard`, park the agentmux pane, and reject later work with HTTP 423.
- An explicit model setting clears the guard and park so one verification turn can run. If the provider falls back again, observation re-establishes the guard.

Queued work remains durable while the guard is active and drains only after an explicit model choice clears it.

## Restart semantics

The runtime registry persists requested settings, the latest observation, and the guard. `agents.yaml` supplies model/effort only when a native agent is first provisioned; a bridge restart must not rewind a manual mid-conversation switch.

Each turn snapshots model and effort before asynchronous engine initialization. A setting changed during an active turn therefore applies deterministically to the following turn for both Claude and Codex.
