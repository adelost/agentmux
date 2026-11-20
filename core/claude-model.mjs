/** WHAT: Defines the fleet default as an exact Claude model. WHY: Prevents upstream alias drift across pane recovery. */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5";
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** WHAT: Resolves a Claude effort. WHY: Keeps source config and resume commands on the same accepted vocabulary. */
export function resolveClaudeEffort(value) {
  if (value == null || value === "") return null;
  const effort = String(value).trim().toLowerCase();
  if (!CLAUDE_EFFORTS.has(effort)) throw new Error(`invalid claudeEffort: ${value}`);
  return effort;
}

/** WHAT: Reads a pane's declared Claude choices. WHY: Keeps normal and quota restarts from choosing different fallbacks. */
export function claudePaneSelection(paneConfig = {}) {
  const command = String(paneConfig.cmd || "");
  const model = paneConfig.model || command.match(/(?:^|\s)--model\s+([a-z0-9._-]+)/iu)?.[1] || null;
  const effort = paneConfig.effort || command.match(/(?:^|\s)--effort\s+([a-z]+)/iu)?.[1] || null;
  return { model: model ? resolveClaudeModel(model) : null, effort: resolveClaudeEffort(effort) };
}

const MODEL_ALIASES = new Map([
  ["opus", "claude-opus-5-5"],
  ["fable", "claude-fable-5-2"],
]);

/** Families whose spoken form (`opus 4.8`) has to become a wire id (`claude-opus-4-8`). */
const SPOKEN_MODEL = /^(?:claude[\s-]+)?(opus|sonnet|haiku|fable)[\s-]*(\d[\d.\s-]*)$/iu;
/** What Claude's `--model` flag and `/model` actually accept, once `[1m]` is off. */
const WIRE_MODEL = /^[a-z0-9._-]+$/iu;
const CONTEXT_SUFFIX = /\[1m\]$/iu;

export const MODEL_NAME_HINT =
  "try `claude-opus-4-8` or `opus 4.8`, or an alias: opus, sonnet, haiku, fable, opusplan";

const spokenAsWireId = (family, version) =>
  `claude-${family.toLowerCase()}-${version.trim().replace(/[.\s-]+/gu, "-").replace(/-$/u, "")}`;

/** Unpinned aliases follow Claude Code's current version of that family. */
const FAMILY_ALIASES = new Set(["sonnet", "haiku"]);

/**
 * WHAT: Checks whether the model a pane runs is the one that was asked for.
 * WHY: Keeps the alias sonnet from leaving a switch to claude-sonnet-5-5 unsaved (claw:0, 2026-10-19).
 */
export function isRequestedClaudeModel(running, requested) {
  const id = String(running || "").toLowerCase().replace(CONTEXT_SUFFIX, "");
  const asked = String(requested || "").toLowerCase().replace(CONTEXT_SUFFIX, "");
  if (MODEL_ALIASES.has(asked)) return id === MODEL_ALIASES.get(asked);
  return Boolean(id) && (id === asked || (FAMILY_ALIASES.has(asked) && id.startsWith(`claude-${asked}-`)));
}

/**
 * WHAT: Turns what a human types into a model name Claude Code accepts.
 * WHY: Keeps a typed `opus 4.8` from failing as unknown; the wire id is `claude-opus-4-8`.
 */
export function normalizeClaudeModelName(raw) {
  // Rejecting the space taught people nothing, so they blamed the version.
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

const fableName = /^(?:claude[- ]+)?fable(?:$|[. _0-9-])/iu;
const modelBase = name => String(name).trim().replace(CONTEXT_SUFFIX, "").trim().toLowerCase();

/** WHAT: Checks whether a Fable selection is allowed. WHY: Prevents launch and compact from running a retired model. */
export function refusedClaudeModel(name) {
  const base = modelBase(name);
  if (!fableName.test(base) || base === "fable") return null;
  const pin = MODEL_ALIASES.get("fable");
  return normalizeClaudeModelName(base).model === pin ? null : `Fable model "${name}" is not allowed. Use ${pin}.`;
}

/** WHAT: Resolves a fleet pin for a Claude name. WHY: Keeps native and tmux selections on the same model. */
export function pinnedClaudeModel(name) {
  const reason = refusedClaudeModel(name);
  if (reason) throw Object.assign(new Error(reason), { code: "FABLE_MODEL_REFUSED" });
  const base = modelBase(name);
  return fableName.test(base) ? MODEL_ALIASES.get("fable") : MODEL_ALIASES.get(base);
}

/** WHAT: Resolves one Claude launch model. WHY: Keeps aliases and status metadata from changing recovery identity. */
export function resolveClaudeModel(value = process.env.AMUX_CLAUDE_MODEL) {
  const requested = String(value || DEFAULT_CLAUDE_MODEL).trim();
  // The custom statusline may append a context annotation to the actual
  // model id. It is display metadata, not accepted by Claude's --model flag.
  const withoutContextSuffix = requested.replace(/\[1m\]$/iu, "");
  const model = pinnedClaudeModel(withoutContextSuffix) || withoutContextSuffix;
  if (!/^[a-z0-9._-]+$/i.test(model)) {
    throw new Error(`invalid Claude model: ${model}`);
  }
  return model;
}

/**
 * WHAT: Resolves a pinned model in a slash command.
 * WHY: Prevents Claude Code from selecting its own stale alias.
 */
export function rewriteModelSlash(text) {
  const m = /^(\/model\s+)(.+)$/iu.exec(String(text).trim());
  if (!m) return text;
  const pinned = pinnedClaudeModel(m[2]);
  return pinned ? `${m[1]}${pinned}` : text;
}
