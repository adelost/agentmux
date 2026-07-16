// Native model observation: keep configured intent separate from engine truth.
//
// Claude exposes the serving model on assistant/result stream-json events.
// Codex persists it in each rollout's `turn_context` JSONL row and may also
// emit `model/rerouted` over app-server.  These helpers normalize both sources
// before the shared model-watch policy classifies a transition.

import { classifyModelChange } from "./model-watch.mjs";

const clean = (value) => String(value || "").trim();
const lower = (value) => clean(value).toLowerCase();

const CLAUDE_ALIASES = ["fable", "mythos", "opus", "sonnet", "haiku"];

export function modelMatchesRequest(requested, observed) {
  const wanted = lower(requested);
  const actual = lower(observed);
  if (!wanted || !actual) return false;
  if (wanted === actual) return true;
  const alias = CLAUDE_ALIASES.find((name) => wanted === name);
  return Boolean(alias && actual.includes(alias));
}

export function observationFromClaudeEvent(event, observedAt = Date.now()) {
  if (event?.type === "assistant") {
    const model = clean(event.message?.model);
    if (model && model !== "<synthetic>") {
      return { model, effort: null, source: "claude-assistant", observedAt };
    }
  }
  if (event?.type === "result") {
    const models = Object.keys(event.modelUsage ?? {}).filter((model) => model && model !== "<synthetic>");
    if (models.length === 1) {
      return { model: models[0], effort: null, source: "claude-result", observedAt };
    }
  }
  return null;
}

export function observationFromCodexEntry(entry, observedAt = Date.now()) {
  if (entry?.type !== "turn_context" || !entry.payload?.model) return null;
  return {
    model: clean(entry.payload.model),
    effort: clean(entry.payload.collaboration_mode?.settings?.reasoning_effort
      ?? entry.payload.effort) || null,
    source: "codex-turn-context",
    observedAt,
    turnId: clean(entry.payload.turn_id) || null,
  };
}

export function latestCodexModelObservation(lines, observedAt = Date.now(), { turnId = null } = {}) {
  const expectedTurnId = clean(turnId);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = String(lines[index] || "");
    if (!line.includes('"turn_context"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const observation = observationFromCodexEntry(entry, observedAt);
    // App-server may announce a new turn before that turn's context row has
    // reached JSONL. Never mistake the previous turn's actual settings for a
    // silent fallback in the new turn; wait for evidence bearing its turn id.
    if (observation && expectedTurnId && observation.turnId !== expectedTurnId) continue;
    if (observation) return observation;
  }
  return null;
}

export function observationFromCodexReroute(params, observedAt = Date.now()) {
  const model = clean(params?.toModel);
  if (!model) return null;
  return {
    model,
    effort: null,
    source: "codex-reroute",
    observedAt,
    turnId: clean(params.turnId) || null,
    reason: clean(params.reason) || null,
    fromModel: clean(params.fromModel) || null,
  };
}

/**
 * Compare a new engine observation with the last observation and the immutable
 * settings snapshot used to start this turn.
 *
 * `change` is null for a first matching sighting and for repeated evidence
 * from the same turn. A first mismatch is deliberately represented as
 * requested -> observed so a fallback cannot hide behind "no previous data".
 */
export function describeModelObservation({ previous = null, observation, requestedModel, requestedEffort = null } = {}) {
  if (!observation?.model) return null;
  const modelExpected = modelMatchesRequest(requestedModel, observation.model);
  const effortExpected = !observation.effort || !requestedEffort
    || lower(observation.effort) === lower(requestedEffort);
  const expected = modelExpected && effortExpected;
  const sameActual = previous?.model === observation.model
    && (observation.effort == null || previous?.effort === observation.effort);
  const sameRequest = previous?.requestedModel === requestedModel
    && previous?.requestedEffort === requestedEffort;

  let change = null;
  if (previous?.model && !sameActual) {
    change = classifyModelChange(previous, observation);
  } else if (!expected && (!previous?.model || !sameRequest)) {
    change = classifyModelChange(
      { model: requestedModel, effort: requestedEffort },
      observation,
    );
  }

  const divergence = expected ? null : classifyModelChange(
    { model: requestedModel, effort: requestedEffort },
    observation,
  );

  return {
    observation: {
      ...observation,
      requestedModel: clean(requestedModel),
      requestedEffort: clean(requestedEffort) || null,
    },
    expected,
    modelExpected,
    effortExpected,
    cause: expected ? "requested" : "automatic",
    change,
    divergence,
  };
}
