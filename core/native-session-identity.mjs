import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectDir } from "./claude-paths.mjs";
import {
  codexSessionIdentityById,
  latestCodexSessionIdentity,
} from "./codex-jsonl-reader.mjs";
import { codexSessionDirs } from "./codex-profiles.mjs";

export const NATIVE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Exact newest Claude session owned by one pane cwd. */
export function latestClaudeSessionIdentity(paneDir, { homeDir = process.env.HOME } = {}) {
  const projectDir = claudeProjectDir(paneDir, homeDir);
  if (!existsSync(projectDir)) return null;
  let files;
  try {
    files = readdirSync(projectDir)
      .filter((name) => NATIVE_SESSION_ID.test(name.replace(/\.jsonl$/u, "")) && name.endsWith(".jsonl"))
      .map((name) => ({ name, mtimeMs: statSync(join(projectDir, name)).mtimeMs }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
  } catch {
    return null;
  }
  if (!files.length) return null;
  const sessionId = files[0].name.slice(0, -".jsonl".length);
  return Object.freeze({ sessionId, cwd: paneDir, path: join(projectDir, files[0].name) });
}

/** Exact persisted session identity for one existing tmux coding pane. */
export function latestPaneSessionIdentity(engine, paneDir, options = {}) {
  if (engine === "claude") return latestClaudeSessionIdentity(paneDir, options);
  if (engine === "codex") return latestCodexSessionIdentity(paneDir, options);
  return null;
}

/**
 * Fail-closed proof used by the runtime import endpoint. The caller supplies
 * the old pane cwd; a UUID alone is never sufficient proof of ownership.
 */
export function persistedSessionIdentity(engine, sessionId, sourceCwd, {
  homeDir = process.env.HOME,
  sessionDirs = codexSessionDirs({ ...process.env, HOME: homeDir }),
} = {}) {
  if (!NATIVE_SESSION_ID.test(String(sessionId || ""))) return null;
  if (engine === "claude") {
    const path = join(claudeProjectDir(sourceCwd, homeDir), `${sessionId}.jsonl`);
    if (!existsSync(path)) return null;
    try {
      if (!statSync(path).isFile()) return null;
    } catch {
      return null;
    }
    return Object.freeze({ sessionId: String(sessionId), cwd: sourceCwd, path });
  }
  if (engine === "codex") {
    return codexSessionIdentityById(sessionId, sourceCwd, { sessionDirs });
  }
  return null;
}
