import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  captureKimiPromptEchoCursor,
  getContextFromKimiJsonl,
  isBusyFromKimiJsonl,
  isPromptInKimiJsonl,
  latestKimiSessionIdentity,
  readLastTurnsKimi,
} from "./kimi-jsonl-reader.mjs";

const SESSION_ID = "session_12345678-1234-4234-9234-123456789abc";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-kimi-wire-"));
  const kimiHome = join(root, ".kimi-code");
  const cwd = join(root, "workspace");
  const sessionDir = join(kimiHome, "sessions", "wd_workspace", SESSION_ID);
  const wire = join(sessionDir, "agents", "main", "wire.jsonl");
  mkdirSync(join(sessionDir, "agents", "main"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(kimiHome, "session_index.jsonl"), `${JSON.stringify({
    sessionId: SESSION_ID,
    sessionDir,
    workDir: cwd,
  })}\n`);
  writeFileSync(join(kimiHome, "config.toml"), [
    '[models."kimi-code/k3"]',
    "max_context_size = 200",
    "",
  ].join("\n"));
  const records = [
    { type: "metadata", protocol_version: "1.4" },
    { type: "config.update", modelAlias: "kimi-code/k3", thinkingEffort: "max", time: 1_000 },
    { type: "turn.prompt", input: [{ type: "text", text: "first prompt" }], time: 2_000 },
    { type: "context.append_message", message: {
      role: "user",
      content: [{ type: "text", text: "first prompt" }],
    }, time: 2_000 },
    { type: "context.append_loop_event", event: {
      type: "step.begin",
      uuid: "step-1",
      turnId: 1,
    }, time: 2_100 },
    { type: "context.append_loop_event", event: {
      type: "content.part",
      stepUuid: "step-1",
      turnId: 1,
      part: { type: "text", text: "KIMI_OK" },
    }, time: 2_200 },
    { type: "context.append_loop_event", event: {
      type: "step.end",
      uuid: "step-1",
      turnId: 1,
      finishReason: "end_turn",
      usage: { inputCacheRead: 20, inputCacheCreation: 10, inputOther: 60, output: 10 },
    }, time: 2_300 },
  ];
  writeFileSync(wire, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return {
    cwd,
    kimiHome,
    wire,
    options: { env: { KIMI_CODE_HOME: kimiHome }, homeDir: root },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("Kimi Wire journal", () => {
  it("provides exact history, completion, context, and pane-owned identity", () => {
    const fx = fixture();
    try {
      expect(latestKimiSessionIdentity(fx.cwd, fx.options)).toMatchObject({
        sessionId: SESSION_ID,
        cwd: fx.cwd,
        path: fx.wire,
      });
      const result = readLastTurnsKimi(fx.cwd, { ...fx.options, limit: 1 });
      expect(result.turns).toHaveLength(1);
      expect(result.turns[0]).toMatchObject({
        userPrompt: "first prompt",
        isComplete: true,
        items: [{ type: "text", content: "KIMI_OK" }],
      });
      expect(isBusyFromKimiJsonl(fx.cwd, fx.options)).toBe(false);
      expect(getContextFromKimiJsonl(fx.cwd, fx.options)).toMatchObject({
        model: "kimi-code/k3",
        tokens: 100,
        max: 200,
        percent: 50,
      });
    } finally {
      fx.cleanup();
    }
  });

  it("accepts a steered prompt after the append cursor and keeps the turn busy", () => {
    const fx = fixture();
    try {
      const cursor = captureKimiPromptEchoCursor(fx.cwd, "first prompt", fx.options);
      expect(isPromptInKimiJsonl(fx.cwd, "first prompt", {
        ...fx.options,
        cursor,
      })).toBe(false);
      appendFileSync(fx.wire, `${JSON.stringify({
        type: "turn.steer",
        input: [{ type: "text", text: "first prompt" }],
        time: 3_000,
      })}\n`);
      expect(isPromptInKimiJsonl(fx.cwd, "first prompt", {
        ...fx.options,
        cursor,
      })).toBe(true);
      expect(isBusyFromKimiJsonl(fx.cwd, fx.options)).toBe(true);
      appendFileSync(fx.wire, `${JSON.stringify({
        type: "context.append_loop_event",
        event: {
          type: "content.part",
          turnId: 2,
          part: { type: "text", text: "STEER_REPLY" },
        },
        time: 3_100,
      })}\n`);
      expect(readLastTurnsKimi(fx.cwd, fx.options).turns.at(-1)).toMatchObject({
        userPrompt: "first prompt",
        items: [{ type: "text", content: "STEER_REPLY" }],
      });
    } finally {
      fx.cleanup();
    }
  });

  it("accepts a collapsed paste marker as receipt for a collapsible prompt, cursor-scoped only", () => {
    const fx = fixture();
    try {
      const longPrompt = `line one\n${"x".repeat(600)}`;
      const cursor = captureKimiPromptEchoCursor(fx.cwd, longPrompt, fx.options);
      const append = (text) => appendFileSync(fx.wire, `${JSON.stringify({
        type: "turn.prompt",
        input: [{ type: "text", text }],
        time: 4_000,
      })}\n`);

      // Strict mode (default) never treats the marker as the receipt.
      append("[paste #1 +2 lines]");
      expect(isPromptInKimiJsonl(fx.cwd, longPrompt, {
        ...fx.options,
        cursor,
      })).toBe(false);

      // Relaxed mode accepts the marker for a needle that itself collapses…
      expect(isPromptInKimiJsonl(fx.cwd, longPrompt, {
        ...fx.options,
        cursor,
        allowPastePlaceholder: true,
      })).toBe(true);

      // …but never for a short needle that cannot collapse: a marker after
      // the cursor then belongs to someone else's paste, not to this job.
      const shortCursor = captureKimiPromptEchoCursor(fx.cwd, "short", fx.options);
      append("[paste #2 900 chars]");
      expect(isPromptInKimiJsonl(fx.cwd, "short", {
        ...fx.options,
        cursor: shortCursor,
        allowPastePlaceholder: true,
      })).toBe(false);

      // And a marker already behind the cursor is not a new receipt.
      const lateCursor = captureKimiPromptEchoCursor(fx.cwd, longPrompt, fx.options);
      expect(isPromptInKimiJsonl(fx.cwd, longPrompt, {
        ...fx.options,
        cursor: lateCursor,
        allowPastePlaceholder: true,
      })).toBe(false);
    } finally {
      fx.cleanup();
    }
  });
});
