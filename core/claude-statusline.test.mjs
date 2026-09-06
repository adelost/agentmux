import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decorateClaudeStatusline,
  normalizeClaudeEffort,
  writeClaudeStatuslineBridge,
} from "./claude-statusline.mjs";

describe("Claude statusline effort bridge", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("shows a bounded provider effort without duplicating an existing label", () => {
    expect(decorateClaudeStatusline("Fable 5 · █░ 13%", "XHIGH"))
      .toBe("Fable 5 · █░ 13% · thinking: xhigh");
    expect(decorateClaudeStatusline("Fable 5 · thinking: xhigh", "xhigh"))
      .toBe("Fable 5 · thinking: xhigh");
    expect(normalizeClaudeEffort("../../max")).toBeNull();
  });

  it("adds model and effort to a freshly delegated GSD context bridge atomically", () => {
    const root = mkdtempSync(join(tmpdir(), "amux-claude-effort-"));
    roots.push(root);
    writeFileSync(join(root, "claude-ctx-session-1.json"), JSON.stringify({
      session_id: "session-1",
      used_pct: 41,
      timestamp: 99,
    }));
    const result = writeClaudeStatuslineBridge({
      session_id: "session-1",
      model: { id: "claude-fable-5" },
      effort: { level: "xhigh" },
      context_window: { used_percentage: 12 },
    }, { directory: root, nowSeconds: () => 99, delegatedSince: 99 });

    expect(result.record).toMatchObject({
      session_id: "session-1",
      used_pct: 41,
      model: "claude-fable-5",
      effort: "xhigh",
      timestamp: 99,
      remaining_percentage: 88,
    });
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toEqual(result.record);
  });

  it("does not freshen an old delegated percent, or invent zero when data is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "amux-claude-effort-"));
    roots.push(root);
    writeFileSync(join(root, "claude-ctx-stale.json"), JSON.stringify({ session_id: "stale", used_pct: 92, timestamp: 1 }));
    expect(writeClaudeStatuslineBridge({ session_id: "stale", context_window: { used_percentage: 0 } },
      { directory: root, nowSeconds: () => 99, delegatedSince: 98 }).record.used_pct).toBe(0);
    expect(writeClaudeStatuslineBridge({ session_id: "stale", context_window: { used_percentage: null } },
      { directory: root, nowSeconds: () => 100 }).record).not.toHaveProperty("used_pct");
  });

  it("the real CLI renders missing context as unknown, not zero", () => {
    const root = mkdtempSync(join(tmpdir(), "amux-claude-effort-"));
    roots.push(root);
    const result = spawnSync(process.execPath, [join(process.cwd(), "bin", "claude-statusline.mjs")], {
      input: JSON.stringify({ session_id: "unknown", model: { display_name: "Fable 5.1" },
        context_window: { used_percentage: null } }),
      encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: root, TMPDIR: root },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Fable 5.1");
    expect(JSON.parse(readFileSync(join(root, "claude-ctx-unknown.json"), "utf8"))).not.toHaveProperty("used_pct");
  });

  it("falls back to Claude's official percent and rejects unsafe session ids", () => {
    const root = mkdtempSync(join(tmpdir(), "amux-claude-effort-"));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    expect(writeClaudeStatuslineBridge({
      session_id: "session-2",
      effort: { level: "high" },
      context_window: { remaining_percentage: 72 },
    }, { directory: root, nowSeconds: () => 100 }).record).toMatchObject({
      used_pct: 28,
      effort: "high",
    });
    expect(writeClaudeStatuslineBridge({
      session_id: "../escape",
      effort: { level: "max" },
    }, { directory: root })).toBeNull();
  });

  it("delegates the statusline and publishes the observed effort end to end", () => {
    const root = mkdtempSync(join(tmpdir(), "amux-claude-effort-"));
    roots.push(root);
    const hooks = join(root, "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(root, "claude-ctx-session-e2e.json"), JSON.stringify({
      session_id: "session-e2e", used_pct: 92, timestamp: Math.floor(Date.now() / 1000),
    }));
    writeFileSync(join(hooks, "gsd-statusline.js"), [
      "process.stdin.resume();",
      "process.stdin.on('end', () => process.stdout.write('Fable 5 · █░ 12%'));",
      "",
    ].join("\n"));
    const input = {
      session_id: "session-e2e",
      model: { id: "claude-fable-5", display_name: "Fable 5" },
      effort: { level: "xhigh" },
      context_window: { used_percentage: 12 },
    };
    const result = spawnSync(process.execPath, [join(process.cwd(), "bin", "claude-statusline.mjs")], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: root, TMPDIR: root },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Fable 5 · █░ 12% · thinking: xhigh");
    expect(JSON.parse(readFileSync(join(root, "claude-ctx-session-e2e.json"), "utf8")))
      .toMatchObject({ effort: "xhigh", model: "claude-fable-5", used_pct: 12 });
  });
});
