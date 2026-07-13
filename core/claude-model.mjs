/** Exact fleet default. Never use the moving `opus` alias here. */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-8";

const MODEL_ALIASES = {
  opus: "claude-opus-4-8",
};

/** Resolve and validate the process-local Claude model override. */
export function resolveClaudeModel(value = process.env.AMUX_CLAUDE_MODEL) {
  const model = String(value || DEFAULT_CLAUDE_MODEL).trim();
  if (!/^[a-z0-9._-]+$/i.test(model)) {
    throw new Error(`invalid Claude model: ${model}`);
  }
  return model;
}

/**
 * Rewrite `/model <alias>` slash commands so the fleet-pinned model
 * is what Claude Code receives, not its own (stale) alias resolution.
 * Returns the text unchanged if no rewrite applies.
 */
export function rewriteModelSlash(text) {
  const m = /^(\/model\s+)(\S+)(\s*)$/i.exec(String(text).trim());
  if (!m) return text;
  const alias = m[2].toLowerCase();
  const pinned = MODEL_ALIASES[alias];
  return pinned ? `${m[1]}${pinned}${m[3]}` : text;
}
