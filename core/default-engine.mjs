import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** WHAT: Resolves whether one executable is installed. WHY: Keeps engine detection free from shell evaluation. */
export function executableAvailable(name, { env = process.env, exists = existsSync } = {}) {
  return String(env.PATH || "").split(delimiter).filter(Boolean)
    .some((directory) => exists(join(directory, name)));
}

/** WHAT: Resolves the first installed coding engine. WHY: Keeps starter projects independent from one engine vendor. */
export function defaultCodingEngine(options = {}) {
  if (executableAvailable("claude", options)) return "claude";
  if (executableAvailable("codex", options)) return "codex";
  const homeKimi = join(options.env?.HOME || process.env.HOME || "", ".kimi-code", "bin", "kimi");
  if (executableAvailable("kimi", options) || executableAvailable("kimi-code", options)
    || (options.exists || existsSync)(homeKimi)) return "kimi";
  throw new Error("no supported coding engine found (Claude Code, Codex, or Kimi Code)");
}
