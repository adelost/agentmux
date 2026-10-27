// Gemini's subscription boundary. No credential files are read or migrated here.
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { esc } from "../lib.mjs";

/** WHAT: Defines inherited paid-auth routes. WHY: Prevents a subscription pane from discovering another billing path. */
export const GEMINI_FORBIDDEN_ENV = Object.freeze([
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_GENAI_USE_GCA", "GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS",
  "GEMINI_CLI_AUTH_OVERRIDE", "GEMINI_CLI_USE_COMPUTE_ADC", "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_CLOUD_PROJECT_ID", "GOOGLE_CLOUD_LOCATION", "GOOGLE_CLOUD_ACCESS_TOKEN", "CLOUD_SHELL",
]);

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const quote = value => `'${esc(String(value))}'`;

/** WHAT: Resolves an explicitly selected Google login. WHY: Prevents missing selection from becoming the operator's API-key home. */
export function geminiProfileHome(login, root = join(homedir(), ".config", "agent", "account-profiles", "gemini")) {
  if (!login) throw new Error("an explicit Gemini profile is required");
  if (!/^[a-z0-9][a-z0-9@._+-]{0,159}$/iu.test(String(login)) || login === "." || login === "..") {
    throw new Error("invalid Gemini profile");
  }
  if (!isAbsolute(root)) throw new Error("Gemini profile root must be absolute");
  return join(root, login);
}

/** WHAT: Builds a child environment without billing overrides. WHY: Keeps other tools' parent environment unchanged. */
export function geminiChildEnvironment(env) {
  const clean = { ...env };
  for (const name of GEMINI_FORBIDDEN_ENV) delete clean[name];
  return clean;
}

/** WHAT: Checks effective launch inputs without inspecting credentials. WHY: Prevents a misconfigured subscription pane from starting Gemini. */
export function assertGeminiStartPolicy({ profileHome, settings, env } = {}) {
  if (!profileHome || !isAbsolute(profileHome)) throw new Error("explicit Gemini profile home must be absolute");
  const auth = settings?.security?.auth;
  if (auth?.selectedType !== "oauth-personal" || (auth.enforcedType && auth.enforcedType !== "oauth-personal")) {
    throw new Error("Gemini launch requires oauth-personal authentication");
  }
  for (const name of GEMINI_FORBIDDEN_ENV) {
    if (Object.hasOwn(env || {}, name)) throw new Error(`Gemini launch refuses ${name}`);
  }
  if (settings?.advanced?.ignoreLocalEnv !== true) {
    throw new Error("Gemini launch requires advanced.ignoreLocalEnv");
  }
  return { ok: true };
}

/** WHAT: Builds the sanitized exact-session TUI command. WHY: Keeps launch and resume on the subscription-only boundary. */
export function buildGeminiLaunchCommand({
  executable, profileHome, sessionId, resume = false, allowFreshBootstrap = false, model = null,
} = {}) {
  if (!executable || !isAbsolute(executable)) throw new Error("Gemini executable must be absolute");
  if (!profileHome || !isAbsolute(profileHome)) throw new Error("explicit Gemini profile home must be absolute");
  if (!SESSION_ID.test(String(sessionId || ""))) throw new Error("invalid Gemini exact session id");
  if (!resume && !allowFreshBootstrap) throw new Error("Gemini fresh bootstrap was not authorized");
  if (model && !/^[a-z0-9][a-z0-9._:/-]{0,159}$/iu.test(String(model))) throw new Error("invalid Gemini model");
  const scrub = GEMINI_FORBIDDEN_ENV.map(name => `-u ${name}`).join(" ");
  const continuity = resume ? "--resume" : "--session-id";
  return `env ${scrub} GEMINI_CLI_HOME=${quote(profileHome)} GEMINI_CLI_NO_RELAUNCH=1 ` +
    `${quote(executable)} ${continuity} ${quote(sessionId)} --approval-mode yolo --skip-trust` +
    (model ? ` -m ${quote(model)}` : "");
}
