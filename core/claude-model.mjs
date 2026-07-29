/** WHAT: Defines the fleet default as an exact Claude model. WHY: Prevents upstream alias drift across pane recovery. */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5";

const MODEL_ALIASES = {
  opus: "claude-opus-5",
};

/** Families whose spoken form (`opus 4.8`) has to become a wire id (`claude-opus-4-8`). */
const SPOKEN_MODEL = /^(?:claude[\s-]+)?(opus|sonnet|haiku|fable)[\s-]*(\d[\d.\s-]*)$/iu;
/** What Claude's `--model` flag and `/model` actually accept, once `[1m]` is off. */
const WIRE_MODEL = /^[a-z0-9._-]+$/iu;
const CONTEXT_SUFFIX = /\[1m\]$/iu;

export const MODEL_NAME_HINT =
  "try `claude-opus-4-8` or `opus 4.8`, or an alias: opus, sonnet, haiku, fable, opusplan";

const spokenAsWireId = (family, version) =>
  `claude-${family.toLowerCase()}-${version.trim().replace(/[.\s-]+/gu, "-").replace(/-$/u, "")}`;

/**
 * WHAT: Turns what a human types into a model name Claude Code accepts.
 * WHY: The wire format is `claude-opus-4-8` but people type `opus 4.8`.
 *      Rejecting the space taught them nothing, so they blamed the version.
 */
export function normalizeClaudeModelName(raw) {
  const input = String(raw ?? "").trim().replace(/\s+/gu, " ");
  if (!input) return { ok: false, reason: "empty model name", hint: MODEL_NAME_HINT };

  const suffix = CONTEXT_SUFFIX.test(input) ? "[1m]" : "";
  const base = input.replace(CONTEXT_SUFFIX, "").trim();

  const spoken = SPOKEN_MODEL.exec(base);
  if (spoken) return { ok: true, model: `${spokenAsWireId(spoken[1], spoken[2])}${suffix}` };
  if (WIRE_MODEL.test(base)) return { ok: true, model: `${base}${suffix}` };

  return {
    ok: false,
    reason: /\s/u.test(base)
      ? "spaces are only allowed as `<family> <version>`, e.g. `opus 4.8`"
      : "not a model id or alias",
    hint: MODEL_NAME_HINT,
  };
}

/** WHAT: Resolves one Claude launch model. WHY: Keeps aliases and status metadata from changing recovery identity. */
export function resolveClaudeModel(value = process.env.AMUX_CLAUDE_MODEL) {
  const requested = String(value || DEFAULT_CLAUDE_MODEL).trim();
  // The custom statusline may append a context annotation to the actual
  // model id. It is display metadata, not accepted by Claude's --model flag.
  const withoutContextSuffix = requested.replace(/\[1m\]$/iu, "");
  const model = MODEL_ALIASES[withoutContextSuffix.toLowerCase()] || withoutContextSuffix;
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
