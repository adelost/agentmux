import { shortModelName } from "./context.mjs";

/** WHAT: Appends the files the turn changed to a footer. WHY: The footer sits inside italic markers, so file names escape the characters Discord would read as formatting. */
const withChanged = (body, changed) => changed ? `${body} · changed: ${String(changed).replace(/[\\_*~`|>]/gu, "\\$&")}` : body;

/** WHAT: Formats the original JSONL context footer. WHY: Keeps model, effort and measured context visible after each answer. */
export function jsonlContextFooter(ctx, changed = "") {
  const suffix = ctx.tokens != null ? ` (${Math.round(ctx.tokens / 1000)}k)` : "";
  const model = shortModelName(ctx.model);
  const modelLabel = model ? `${model}${ctx.effort ? ` ${ctx.effort}` : ""}` : null;
  const prefix = modelLabel ? `${modelLabel} · ` : "";
  return `_${withChanged(`${prefix}context: ${ctx.percent}%${suffix}`, changed)}_`;
}

/** WHAT: Formats the original native runtime context footer. WHY: Uses the runtime's observed model and context without losing its effort. */
export function nativeContextFooter(agent, changed = "") {
  const context = agent.context;
  const model = shortModelName(agent.observedModel || agent.model);
  const modelLabel = [model, agent.observedEffort || agent.effort].filter(Boolean).join(" ");
  const tokens = Number.isFinite(context.usedTokens)
    ? ` (${Math.round(context.usedTokens / 1_000)}k)` : "";
  return `_${withChanged(`${modelLabel ? `${modelLabel} · ` : ""}context: ${Math.round(context.percent)}%${tokens}`, changed)}_`;
}
