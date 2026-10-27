// Antigravity CLI (agy) replaced Gemini CLI for Google AI subscriptions on 18 Jun 2026.
// agy owns its Google login. AMUX never reads its credential files.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { esc } from "../lib.mjs";

/** WHAT: Defines inherited authentication overrides to remove. WHY: Keeps the launch on the operator's Google login, never a paid key. */
export const GEMINI_UNSET = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_GCA",
  "GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS", "GEMINI_CLI_AUTH_OVERRIDE"];
const SESSION_KEY = "gemini_session_by_pane_v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TRUST_PROMPT = /Do you trust the contents of this project\?/u;
const COMPOSER_READY = /^\? for shortcuts/mu;
const quote = value => `'${esc(String(value))}'`;

/** WHAT: Resolves agy's own state directory. WHY: Keeps every agy file read on one root that tests can replace. */
export const agyHome = (home = homedir()) => join(home, ".gemini", "antigravity-cli");

/** WHAT: Reads the conversation agy last opened in one workspace. WHY: Keeps resume on the pane's own workspace, since agy has no start-time id flag. */
export function lastAgyConversation(dir, { home } = {}) {
  try {
    const id = JSON.parse(readFileSync(join(agyHome(home), "cache", "last_conversations.json"), "utf8"))?.[dir];
    return UUID.test(id || "") ? id : null;
  } catch { return null; }
}

/** WHAT: Builds an agy launch that always auto-approves tools. WHY: Keeps every Gemini pane in YOLO and prevents a guessed resume. */
export function buildGeminiLaunchCommand({ conversationId = null, model = null, executable = "agy" } = {}) {
  if (conversationId !== null && !UUID.test(conversationId)) throw new Error("Antigravity requires an exact conversation UUID");
  if (model && !/^[a-z0-9][a-z0-9._:/-]{0,159}$/iu.test(model)) throw new Error("invalid Antigravity model");
  return `env ${GEMINI_UNSET.map(name => `-u ${name}`).join(" ")} ${quote(executable)} --dangerously-skip-permissions` +
    `${conversationId ? ` --conversation ${quote(conversationId)}` : ""}${model ? ` --model ${quote(model)}` : ""}`;
}

/** WHAT: Resolves a pane's persisted agy conversation. WHY: Keeps restart bound to that pane rather than another workspace. */
export const geminiSession = (state, name, pane) => state?.get(SESSION_KEY, {})?.[`${name}:${pane}`] || null;

/** WHAT: Builds the small persistent agy TUI lifecycle. WHY: Keeps Google login and screen observation independent from provider journal readers. */
export function createGeminiRuntime({ t, state, paneDir, agentConfig, isAlreadyRunning, isPaneDead, respawnPane,
  captureScreen, assertEngineStartAllowed, wait, home, now = () => performance.now(), executable = "agy" } = {}) {
  return { async startGemini(name, target, rootDir, pane = 0, launch = null) {
    if (!state?.set) throw new Error("Gemini session state is unavailable");
    const dir = paneDir(rootDir, pane);
    const previous = geminiSession(state, name, pane);
    if (previous && ((previous.sessionId && !UUID.test(previous.sessionId)) || previous.dir !== dir)) {
      throw new Error("Gemini continuity blocked: invalid pane session");
    }
    if (await isAlreadyRunning(target)) {
      if (!previous) throw new Error("Gemini continuity blocked: running process has no owned session");
      return { started: false, sessionId: previous.sessionId };
    }
    const config = agentConfig(name).panes?.[pane] || {};
    const explicit = launch?.resumeSessionId || config.resumeSessionId;
    // A pane AMUX started before owns the conversation agy recorded for its workspace.
    const owned = previous?.sessionId || (previous ? lastAgyConversation(dir, { home }) : null);
    if (owned && explicit && explicit !== owned) throw new Error("Gemini continuity blocked: different configured UUID");
    const sessionId = explicit || owned || null;
    const command = buildGeminiLaunchCommand({ conversationId: sessionId, model: config.model, executable });
    await assertEngineStartAllowed({ session: name, pane, dir, sessionId, engine: "gemini" });
    const update = current => ({ ...current, [`${name}:${pane}`]: { sessionId, dir } });
    if (state.updateKey) state.updateKey(SESSION_KEY, update); else state.set(SESSION_KEY, update(state.get(SESSION_KEY, {})));
    if (await isPaneDead(target)) await respawnPane(target);
    await t.sendLiteral(target, `cd ${quote(dir)} && ${command}`);
    await t.sendEnter(target);
    const deadline = now() + 30_000;
    while (now() < deadline) {
      const screen = await captureScreen(name, pane);
      // The pane directory is AMUX-configured; agy asks once per new workspace.
      if (TRUST_PROMPT.test(screen)) await t.sendEnter(target);
      else if (COMPOSER_READY.test(screen)) return { started: true, sessionId };
      await wait(250);
    }
    throw new Error("Antigravity did not reach its composer; inspect login in the normal agy CLI before retrying");
  } };
}
