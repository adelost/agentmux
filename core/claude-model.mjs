/** Exact fleet default. Never use the moving `opus` alias here. */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-6";

/** Resolve and validate the process-local Claude model override. */
export function resolveClaudeModel(value = process.env.AMUX_CLAUDE_MODEL) {
  const model = String(value || DEFAULT_CLAUDE_MODEL).trim();
  if (!/^[a-z0-9._-]+$/i.test(model)) {
    throw new Error(`invalid Claude model: ${model}`);
  }
  return model;
}
