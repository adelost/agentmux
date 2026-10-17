import { shortModelName } from "./context.mjs";

/** WHAT: Formats the original JSONL context footer. WHY: Keeps model, effort and measured context visible after each answer. */
export function jsonlContextFooter(ctx) {
  const suffix = ctx.tokens != null ? ` (${Math.round(ctx.tokens / 1000)}k)` : "";
  const model = shortModelName(ctx.model);
  const modelLabel = model ? `${model}${ctx.effort ? ` ${ctx.effort}` : ""}` : null;
  const prefix = modelLabel ? `${modelLabel} · ` : "";
  return `_${prefix}context: ${ctx.percent}%${suffix}_`;
}

/** WHAT: Formats the original native runtime context footer. WHY: Uses the runtime's observed model and context without losing its effort. */
export function nativeContextFooter(agent) {
  const context = agent.context;
  const model = shortModelName(agent.observedModel || agent.model);
  const modelLabel = [model, agent.observedEffort || agent.effort].filter(Boolean).join(" ");
  const tokens = Number.isFinite(context.usedTokens)
    ? ` (${Math.round(context.usedTokens / 1_000)}k)` : "";
  return `_${modelLabel ? `${modelLabel} · ` : ""}context: ${Math.round(context.percent)}%${tokens}_`;
}
