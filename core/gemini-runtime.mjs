// The ordinary Gemini CLI owns Google login. AMUX never reads its credential files.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { esc } from "../lib.mjs";

/** WHAT: Defines inherited authentication overrides to remove. WHY: Keeps the launch on the operator's normal Google login. */
export const GEMINI_UNSET = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_GCA",
  "GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS", "GEMINI_CLI_AUTH_OVERRIDE"];
const SESSION_KEY = "gemini_session_by_pane_v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const quote = value => `'${esc(String(value))}'`;

/** WHAT: Checks the normal CLI's selected authentication. WHY: Prevents an API-key configuration from starting a paid Gemini pane. */
export function assertGeminiOAuthStart({ settings, settingsPath = join(homedir(), ".gemini", "settings.json") } = {}) {
  if (settings === undefined) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { settings = null; }
  }
  if (settings?.security?.auth?.selectedType !== "oauth-personal") {
    throw new Error("Gemini start refused: log in with Google first (oauth-personal is required)");
  }
  return { ok: true };
}

/** WHAT: Builds an exact-session ordinary Gemini launch. WHY: Keeps startup away from API-auth overrides and global latest-session guesses. */
export function buildGeminiLaunchCommand({ sessionId, resume = false, model = null, executable = "gemini" } = {}) {
  if (!UUID.test(sessionId || "")) throw new Error("Gemini requires an exact session UUID");
  if (model && !/^[a-z0-9][a-z0-9._:/-]{0,159}$/iu.test(model)) throw new Error("invalid Gemini model");
  return `env ${GEMINI_UNSET.map(name => `-u ${name}`).join(" ")} ${quote(executable)} --yolo --skip-trust ` +
    `${resume ? "--resume" : "--session-id"} ${quote(sessionId)}${model ? ` -m ${quote(model)}` : ""}`;
}

/** WHAT: Resolves a pane's persisted Gemini session. WHY: Keeps echo verification bound to that pane rather than another CLI journal. */
export const geminiSession = (state, name, pane) => state?.get(SESSION_KEY, {})?.[`${name}:${pane}`] || null;

/** WHAT: Builds Gemini's small persistent TUI lifecycle. WHY: Keeps Google login and screen observation independent from provider journal readers. */
export function createGeminiRuntime({ t, state, paneDir, agentConfig, isAlreadyRunning, isPaneDead, respawnPane,
  captureScreen, assertEngineStartAllowed, wait, settings, now = () => performance.now(), executable = "gemini" } = {}) {
  return { async startGemini(name, target, rootDir, pane = 0, launch = null) {
    assertGeminiOAuthStart({ settings });
    if (!state?.set) throw new Error("Gemini session state is unavailable");
    const dir = paneDir(rootDir, pane);
    const previous = geminiSession(state, name, pane);
    if (previous && (!UUID.test(previous.sessionId || "") || previous.dir !== dir)) throw new Error("Gemini continuity blocked: invalid pane session");
    if (await isAlreadyRunning(target)) {
      if (!previous) throw new Error("Gemini continuity blocked: running process has no owned session");
      return { started: false, sessionId: previous.sessionId };
    }
    const config = agentConfig(name).panes?.[pane] || {};
    const explicit = launch?.resumeSessionId || config.resumeSessionId;
    if (previous && explicit && explicit !== previous.sessionId) throw new Error("Gemini continuity blocked: different configured UUID");
    const sessionId = explicit || previous?.sessionId || randomUUID();
    const command = buildGeminiLaunchCommand({ sessionId, resume: Boolean(explicit || previous), model: config.model, executable });
    await assertEngineStartAllowed({ session: name, pane, dir, sessionId: previous?.sessionId || explicit, engine: "gemini" });
    const update = current => ({ ...current, [`${name}:${pane}`]: { sessionId, dir } });
    if (state.updateKey) state.updateKey(SESSION_KEY, update); else state.set(SESSION_KEY, update(state.get(SESSION_KEY, {})));
    if (await isPaneDead(target)) await respawnPane(target);
    await t.sendLiteral(target, `cd ${quote(dir)} && ${command}`);
    await t.sendEnter(target);
    const deadline = now() + 30_000;
    while (now() < deadline) {
      if (/^\s*\*\s+Type your message/imu.test(await captureScreen(name, pane))) return { started: true, sessionId };
      await wait(250);
    }
    throw new Error("Gemini did not reach its composer; inspect login in the normal CLI before retrying");
  } };
}
