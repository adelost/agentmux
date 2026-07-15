import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeProjectDir } from "./claude-paths.mjs";
import {
  latestClaudeSessionIdentity,
  persistedSessionIdentity,
} from "./native-session-identity.mjs";

const CLAUDE_ID = "11111111-1111-4111-8111-111111111111";
const CODEX_ID = "22222222-2222-4222-8222-222222222222";

describe("native persisted session identity", () => {
  it("finds only an exact Claude pane session", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "amux-native-id-"));
    const paneDir = join(homeDir, "repo", ".agents", "2");
    const projectDir = claudeProjectDir(paneDir, homeDir);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${CLAUDE_ID}.jsonl`), "{}\n");

    expect(latestClaudeSessionIdentity(paneDir, { homeDir })).toMatchObject({
      sessionId: CLAUDE_ID,
      cwd: paneDir,
    });
    expect(persistedSessionIdentity("claude", CLAUDE_ID, paneDir, { homeDir }))
      .toMatchObject({ sessionId: CLAUDE_ID, cwd: paneDir });
    expect(persistedSessionIdentity("claude", CLAUDE_ID, join(homeDir, "repo"), { homeDir }))
      .toBeNull();
  });

  it("requires Codex thread id and cwd to match the same rollout", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "amux-native-id-"));
    const paneDir = join(homeDir, "repo", ".agents", "4");
    const sessionDir = join(homeDir, ".codex", "sessions", "2026", "07", "16");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, `rollout-${CODEX_ID}.jsonl`), `${JSON.stringify({
      type: "session_meta",
      payload: { id: CODEX_ID, cwd: paneDir },
    })}\n`);

    expect(persistedSessionIdentity("codex", CODEX_ID, paneDir, {
      homeDir,
      sessionDirs: [join(homeDir, ".codex", "sessions")],
    })).toMatchObject({ sessionId: CODEX_ID, cwd: paneDir });
    expect(persistedSessionIdentity("codex", CODEX_ID, join(homeDir, "repo"), {
      homeDir,
      sessionDirs: [join(homeDir, ".codex", "sessions")],
    })).toBeNull();
  });
});
