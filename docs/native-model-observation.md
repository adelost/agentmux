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

Aliases such as `fable` and `opus` match their full Claude model identifiers. An exact configured model also matches its dated provider variant, while neighboring versions do not. Unknown aliases are not guessed.

A successful turn without any supported actual-model evidence emits `web:model-observation-missing`, an append-only fleet event, a Discord warning, and one push notification. Missing evidence does not silently claim that the requested model was served.

## Transition and safety policy

`core/model-watch.mjs` remains the only classifier for upgrade, lateral change, and downgrade. Native runtime events carry that result to both code.v1d.io and the Discord watcher.

- Every observed transition emits `web:model-change` and, for an agentmux-bound pane, an append-only `model_change` fleet event.
- Requested switches are visible but allowed.
- Automatic lateral frontier changes such as Fable to Opus warn but continue.
- Automatic downgrades interrupt the current turn, set `modelGuard`, park the agentmux pane, and reject later work with HTTP 423.
- An explicit model setting clears the guard and park so one verification turn can run. If the provider falls back again, observation re-establishes the guard.

Queued work remains durable while the guard is active and drains only after an explicit model choice clears it.
The delivery broker permanently tests this beyond its normal one-hour pre-submit timeout; a parked native job remains pending rather than becoming a false `NOT SENT` terminal record.

## CLI model visibility

`amux ps` keeps model evidence independent of context usage. `[selected]`
means the visible Codex footer/current status or native runtime selection;
`[configured]` means only the saved override for that exact pane. `last:` is
the latest observed turn, not proof that a new turn ran on that model. Different
selected and observed models are shown together; matching live labels are coalesced.
Shell-returned and dead tmux panes show `stopped`, retain labelled history, and
never present their old context percentage as live usage. Model-bearing idle
panes remain expanded even with no usage reading. Missing context is `N/A`, not
0%. Codex compaction totals use `last_token_usage.total_tokens`, not zeroed
breakdown fields or lifetime totals. A current native status percentage outranks
reconstructed JSONL usage; a status in scrollback does not. The CLI only reads existing captures,
session observations and overrides; it does not drive `/status`, restart a
session, infer a fleet default, or create another cache/poller.

## Restart semantics

The runtime registry persists requested settings, the latest observation, and the guard. `agents.yaml` supplies model/effort only when a native agent is first provisioned; a bridge restart must not rewind a manual mid-conversation switch.

Each turn snapshots model and effort before asynchronous engine initialization. A setting changed during an active turn therefore applies deterministically to the following turn for both Claude and Codex.
