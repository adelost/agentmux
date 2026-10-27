// Pane-owned observation files, never credentials or a cwd-global latest session.
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { readQwenJournalWindow as readJournalWindow } from "./qwen-journal-window.mjs";
import { GEMINI_FORBIDDEN_ENV } from "./gemini-launch.mjs";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GENERATION = /^[a-z0-9._-]{1,160}$/iu;
const stateBase = root => resolve(root || join(homedir(), ".agentmux", "gemini-panes"));

/** WHAT: Resolves one private pane observation root. WHY: Keeps two Gemini panes' receipt streams separate. */
export function geminiWatchDir(paneDir, { stateRoot } = {}) {
  return join(stateBase(stateRoot), createHash("sha256").update(resolve(paneDir)).digest("hex"));
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function save(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}

function transcriptAllowed(path, profileHome) {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  const root = join(profileHome, ".gemini", "tmp") + sep;
  return resolve(path).startsWith(root) && /[\/]chats[\/]session-[a-z0-9T._-]+\.jsonl$/iu.test(path);
}

function validBinding(value, paneDir, root) {
  return value?.version === 1 && value.root === root && value.paneDir === resolve(paneDir)
    && SESSION_ID.test(value.sessionId || "") && GENERATION.test(value.generation || "")
    && typeof value.profileHome === "string" && isAbsolute(value.profileHome)
    && value.eventsPath === join(root, `events-${value.generation}.jsonl`)
    && (value.path == null || transcriptAllowed(value.path, value.profileHome));
}

function readBinding(path, paneDir, root, strict) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!validBinding(value, paneDir, root)) throw new Error("invalid Gemini binding");
    return value;
  } catch (error) {
    if (strict && error.code !== "ENOENT") throw new Error("Gemini continuity blocked: invalid runtime receipt; preserve it for inspection");
    return null;
  }
}

/** WHAT: Reads the published identity or strict pending launch intent. WHY: Prevents a crash or corrupt receipt from authorizing a fresh session. */
export function latestGeminiSessionIdentity(paneDir, { stateRoot, strict = false } = {}) {
  const root = geminiWatchDir(paneDir, { stateRoot });
  if (strict) {
    const starting = readBinding(join(root, "starting.json"), paneDir, root, true);
    if (starting) return starting;
  }
  return readBinding(join(root, "runtime.json"), paneDir, root, strict);
}

/** WHAT: Builds private generation files and durable startup intent. WHY: Keeps process replacement from losing the intended exact session. */
export function prepareGeminiRuntimeFiles(paneDir, {
  stateRoot, profileHome, sessionId, model = null, generation = `${Date.now()}-${randomUUID()}`,
} = {}) {
  if (!SESSION_ID.test(sessionId || "")) throw new Error("invalid Gemini session id");
  if (!GENERATION.test(generation || "")) throw new Error("invalid Gemini generation");
  if (!profileHome || !isAbsolute(profileHome)) throw new Error("explicit Gemini profile home must be absolute");
  const root = geminiWatchDir(paneDir, { stateRoot });
  privateDirectory(stateBase(stateRoot));
  privateDirectory(root);
  const files = { version: 1, root, paneDir: resolve(paneDir), sessionId, profileHome: resolve(profileHome),
    model, generation, eventsPath: join(root, `events-${generation}.jsonl`) };
  writeFileSync(files.eventsPath, "", { mode: 0o600, flag: "wx" });
  save(join(root, "starting.json"), files);
  return Object.freeze(files);
}

/** WHAT: Builds a published identity from an exact clean SessionStart. WHY: Prevents dotenv-loaded keys or another process from admitting delivery. */
export function publishGeminiRuntime(files) {
  const { events } = readJournalWindow(files.eventsPath, { head: true, maxBytes: 64 * 1024 });
  const start = events.find(event => event.hook_event_name === "SessionStart"
    && event.session_id === files.sessionId && event.generation === files.generation && event.cwd === files.paneDir);
  if (!start || !transcriptAllowed(start.transcript_path, files.profileHome)
      || !GEMINI_FORBIDDEN_ENV.every(name => start.environment?.[name] === false)) {
    throw new Error("Gemini startup refused: missing exact session or clean effective environment attestation");
  }
  const identity = { ...files, path: start.transcript_path, publishedAt: new Date().toISOString() };
  save(join(files.root, "runtime.json"), identity);
  try { unlinkSync(join(files.root, "starting.json")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return identity;
}
