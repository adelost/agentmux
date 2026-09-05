import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { claudeProjectDir } from "./claude-paths.mjs";
import { readReminderActivity } from "./reminder-activity.mjs";

let home, pane;
const stamp = (n) => new Date(Date.UTC(2026, 8, 5, 10, n)).toISOString();
const prompts = ["implement the task", "[drift-guard] refresh", "[dream] digest", "continue the implementation"];
function journal(file, rows) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "amux-reminder-history-")); pane = join(home, "workspace/.agents/0");
  mkdirSync(pane, { recursive: true });
  vi.stubEnv("HOME", home); vi.stubEnv("CODEX_HOME", join(home, ".codex")); vi.stubEnv("KIMI_CODE_HOME", join(home, ".kimi-code"));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe("real engine journals for drift activity", () => {
  it.each(["claude", "codex", "kimi"])("uses %s work timestamps and compactions, never fresh housekeeping as work", (engine) => {
    if (engine === "claude") journal(join(claudeProjectDir(pane), "fixture.jsonl"), [
      ...prompts.map((text, n) => ({ type: "user", message: { content: text }, timestamp: stamp(n) })),
      { type: "system", isCompactSummary: true, timestamp: stamp(4) },
    ]);
    if (engine === "codex") journal(join(home, ".codex/sessions/2026/09/05/rollout-fixture.jsonl"), [
      { type: "session_meta", payload: { cwd: pane, source: "cli", originator: "codex-tui" } },
      ...prompts.flatMap((text, n) => [
        { type: "event_msg", timestamp: stamp(n), payload: { type: "task_started", turn_id: `T${n}` } },
        { type: "event_msg", timestamp: stamp(n), payload: { type: "user_message", message: text } },
        { type: "event_msg", timestamp: stamp(n), payload: { type: "task_complete", turn_id: `T${n}` } },
      ]), { type: "compacted", timestamp: stamp(4) },
    ]);
    if (engine === "kimi") {
      const sessionId = "session_12345678-1234-4234-9234-123456789abc";
      const sessionDir = join(home, ".kimi-code/sessions/wd_fixture", sessionId);
      journal(join(home, ".kimi-code/session_index.jsonl"), [{ sessionId, sessionDir, workDir: pane }]);
      journal(join(sessionDir, "agents/main/wire.jsonl"), [
        ...prompts.flatMap((text, n) => [
          { type: "turn.prompt", input: [{ type: "text", text }], time: Date.parse(stamp(n)) },
          { type: "context.append_message", message: { role: "user", content: [{ type: "text", text }] }, time: Date.parse(stamp(n)) },
        ]), { type: "context.apply_compaction", time: Date.parse(stamp(4)) },
      ]);
    }
    expect(readReminderActivity(pane, engine, null)).toMatchObject({ count: 2, latest: stamp(3), latestCompactTs: Date.parse(stamp(4)) });
    expect(readReminderActivity(pane, engine, Date.parse(stamp(0)))).toMatchObject({ count: 1, latest: stamp(3) });
    expect(readReminderActivity(pane, engine, Date.parse(stamp(4)))).toMatchObject({ count: 0, latest: null });
  });
  it("missing engine journals cannot become work", () => {
    for (const engine of ["claude", "codex", "kimi"]) {
      const activity = readReminderActivity(pane, engine, null);
      expect(activity.count || 0).toBe(0); expect(activity.latest).toBeFalsy();
    }
  });
});
