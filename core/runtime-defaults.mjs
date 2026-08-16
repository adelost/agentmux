import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** WHAT: Names the standalone AMUX tmux socket. WHY: Keeps core startup separate from another product's socket. */
export const DEFAULT_TMUX_SOCKET = join(tmpdir(), "agentmux-tmux.sock");

/** WHAT: Names the neutral default speech voice. WHY: Prevents a public install from impersonating one operator. */
export const DEFAULT_TTS_VOICE = "en-US-AriaNeural";

/** WHAT: Names the operator without assuming a person. WHY: Keeps shared status text separate from one identity. */
export const DEFAULT_OPERATOR_NAME = "the operator";

/**
 * WHAT: Normalizes one explicitly configured HTTPS service root.
 * WHY: Prevents optional integrations from inventing a private service origin.
 */
export function normalizeServiceBaseUrl(value, label, { allowHttpLoopback = false } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is not configured`);
  }
  let url;
  try { url = new URL(value.trim()); }
  catch { throw new Error(`${label} must be an absolute HTTPS URL`); }
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]).has(url.hostname);
  if (url.protocol !== "https:" && !(allowHttpLoopback && url.protocol === "http:" && loopback)) {
    throw new Error(`${label} must use HTTPS${allowHttpLoopback ? " (or loopback HTTP for tests)" : ""}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not contain credentials, query, or fragment`);
  }
  if (url.pathname !== "/" && url.pathname.replace(/\/+$/u, "") !== "") {
    throw new Error(`${label} must be an origin without a path`);
  }
  return url.origin;
}

/** WHAT: Resolves the configured operator label. WHY: Prevents human-facing state from hardcoding the author's name. */
export function operatorName(env = process.env) {
  const value = String(env.AMUX_OPERATOR_NAME || "").trim();
  return value || DEFAULT_OPERATOR_NAME;
}

/** WHAT: Resolves standalone AMUX memory. WHY: Keeps optional OpenClaw compatibility separate from core storage. */
export function defaultWorkspace(home = homedir()) {
  return join(home, ".agentmux", "workspace");
}

/** WHAT: Resolves standalone AMUX tasks. WHY: The todo command must work without an OpenClaw installation. */
export function defaultTodosPath(home = homedir()) {
  return join(defaultWorkspace(home), "memory", "tasks.md");
}

/** WHAT: Resolves the generated pane configuration. WHY: Keeps CLI and bridge on one external runtime truth. */
export function runtimeAgentsPath(env = process.env, home = homedir()) {
  return env.AGENTS_YAML || env.AGENT_CONFIG || join(home, ".agentmux", "agents.yaml");
}
