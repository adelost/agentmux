// Shell-safe coding-agent launch construction shared by pane lifecycle paths.

import { esc } from "../lib.mjs";
import { resolveClaudeModel } from "./claude-model.mjs";
import { CLAUDE_AUTONOMOUS_FLAGS, CODEX_AUTONOMOUS_FLAGS } from "./execution-safety.mjs";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const shellQuote = (value) => `'${esc(String(value))}'`;

function exactSessionId(value, engine) {
  if (value == null || value === "") return null;
  const sessionId = String(value);
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`invalid ${engine} resume session id: ${sessionId}`);
  }
  return sessionId;
}

/**
 * WHAT: Builds a pinned Claude launch with optional exact-session resume.
 * WHY: Prevents model alias drift and fresh-session fallback during recovery.
 */
export function buildClaudeLaunchCommand({
  resume = false,
  resumeSessionId = null,
  model = resolveClaudeModel(),
} = {}) {
  const exactModel = resolveClaudeModel(model);
  const exactResume = exactSessionId(resumeSessionId, "Claude");
  const sessionFlag = exactResume
    ? ` --resume ${shellQuote(exactResume)}`
    : resume ? " --continue" : "";
  return `ANTHROPIC_DISABLE_SURVEY=1 claude ${CLAUDE_AUTONOMOUS_FLAGS} --model ${shellQuote(exactModel)}${sessionFlag}`;
}

/**
 * WHAT: Builds an account-isolated Codex launch with explicit bootstrap or resume.
 * WHY: Prevents pane recovery from attaching to an unrelated latest session.
 */
export function buildCodexLaunchCommand({
  profileHome,
  model = null,
  effort = null,
  resumeSessionId = null,
  allowFreshBootstrap = false,
} = {}) {
  if (!profileHome) throw new Error("Codex profile home is required");
  if (model && !/^[a-z0-9._-]+$/iu.test(model)) throw new Error(`invalid Codex model: ${model}`);
  if (effort && !/^(minimal|low|medium|high|xhigh|max|ultra)$/iu.test(effort)) {
    throw new Error(`invalid Codex reasoning effort: ${effort}`);
  }
  const overrideFlags = [
    model ? `-m ${shellQuote(model)}` : "",
    effort ? `-c ${shellQuote(`model_reasoning_effort="${effort.toLowerCase()}"`)}` : "",
  ].filter(Boolean).join(" ");
  const flags = [CODEX_AUTONOMOUS_FLAGS, overrideFlags].filter(Boolean).join(" ");
  const env = `CODEX_HOME=${shellQuote(profileHome)}`;
  const exactResume = exactSessionId(resumeSessionId, "Codex");
  if (exactResume) return `${env} codex resume ${shellQuote(exactResume)} ${flags}`;
  if (!allowFreshBootstrap) {
    throw new Error("Codex launch requires an exact pane session; fresh bootstrap was not authorized");
  }
  return `${env} codex ${flags}`;
}
