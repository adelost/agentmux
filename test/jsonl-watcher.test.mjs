import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createJsonlWatcher } from "../channels/jsonl-watcher.mjs";

// --- Setup helpers --------------------------------------------------------

function mkState(initial = {}) {
  const data = { ...initial };
  return {
    get: vi.fn((key, def) => {
      if (Object.hasOwn(data, key)) return data[key];
      return def;
    }),
    set: vi.fn((key, value) => { data[key] = value; }),
    _data: data,
  };
}

function mkDiscord({ paceMs = 0 } = {}) {
  const sends = [];
  return {
    sends,
    send: vi.fn(async (channelId, payload) => {
      sends.push({ channelId, payload, t: Date.now() });
      if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
      return true;
    }),
    sendTyping: vi.fn(async () => {}),
  };
}

function setupWatcher({ jsonlLines = [], stateInitial = {} } = {}) {
  const fakeHome = mkdtempSync(join(tmpdir(), "agentmux-watcher-test-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;

  // agent.dir is the workspace ROOT; paneDir() appends .agents/N to it.
  // Both must exist on disk because paneDir() does a mkdirSync + writes a
  // .gitignore. Keep them inside fakeHome so cleanup works.
  const agentRootDir = join(fakeHome, "workspace");
  mkdirSync(agentRootDir, { recursive: true });
  writeFileSync(join(agentRootDir, ".gitignore"), ".agents/\n");
  const paneDirPath = join(agentRootDir, ".agents", "0");
  mkdirSync(paneDirPath, { recursive: true });

  const encoded = paneDirPath.replace(/[\/\.]/g, "-");
  const projectDir = join(fakeHome, ".claude", "projects", encoded);
  mkdirSync(projectDir, { recursive: true });

  const jsonlPath = join(projectDir, "session-test.jsonl");
  writeJsonl(jsonlPath, jsonlLines);

  const agentsYamlPath = join(fakeHome, "agents.yaml");
  writeFileSync(agentsYamlPath, [
    "testagent:",
    `  dir: ${agentRootDir}`,
    "  panes:",
    "    - cmd: claude",
    "  discord:",
    "    \"ch-test\": 0",
    "",
  ].join("\n"));

  const agent = {
    capturePane: vi.fn(async () => ""),
    getContextPercent: vi.fn(() => null),
  };
  const discord = mkDiscord();
  const state = mkState(stateInitial);

  const watcher = createJsonlWatcher({
    agent,
    agentsYamlPath,
    discord,
    state,
    log: () => {},
  });

  return {
    watcher,
    discord,
    state,
    agent,
    jsonlPath,
    agentRootDir,
    appendJsonl: (lines) => appendJsonl(jsonlPath, lines),
    cleanup: () => {
      watcher.stop();
      process.env.HOME = origHome;
      rmSync(fakeHome, { recursive: true, force: true });
    },
  };
}

function writeJsonl(path, lines) {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
}

function appendJsonl(path, lines) {
  const { appendFileSync } = require("fs");
  appendFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  // bump mtime to NOW so latestJsonlMtime reflects the append
  const now = Date.now() / 1000;
  utimesSync(path, now, now);
}

function userTurn(content, ts) {
  return { type: "user", message: { role: "user", content }, uuid: `u-${ts}`, timestamp: ts };
}

function assistantText(text, ts, stop_reason = null) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason,
    },
    uuid: `a-${ts}`,
    timestamp: ts,
  };
}

function assistantTool(name, input, ts) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name, input, id: `tu-${ts}` }],
      stop_reason: "tool_use",
    },
    uuid: `at-${ts}`,
    timestamp: ts,
  };
}

function toolResult(content, ts) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `tu-prev`, content }],
    },
    uuid: `tr-${ts}`,
    timestamp: ts,
  };
}

// --- Tests ----------------------------------------------------------------

feature("watcher: long agent turn with tool calls posts ALL content", () => {
  unit("text + 2 tool_use + final text + end_turn → one post with all 3 items", {
    given: ["a jsonl with full multi-step turn ending in end_turn", () => {
      const userTs = "2026-04-30T20:00:00.000Z";
      const lines = [
        userTurn("plan it", userTs),
        assistantText("Innan jag skriver, kollar två filer.", "2026-04-30T20:00:01.000Z"),
        assistantTool("Bash", { command: "cat wrangler.toml" }, "2026-04-30T20:00:02.000Z"),
        toolResult("PACKAGE=foo", "2026-04-30T20:00:03.000Z"),
        assistantTool("Bash", { command: "ls src/" }, "2026-04-30T20:00:04.000Z"),
        toolResult("file list", "2026-04-30T20:00:10.000Z"),
        assistantText("Sparat planen i docs/multi-club-plan.md.", "2026-04-30T20:00:15.000Z", "end_turn"),
      ];
      const ctx = setupWatcher({
        jsonlLines: lines,
        // Pretend we already saw the user prompt — checkpoint is BEFORE
        // the assistant content, so all assistant items qualify.
        stateInitial: {
          watcher_last_posted_ts: { "ch-test": new Date(userTs).getTime() - 1 },
        },
      });
      return ctx;
    }],
    when: ["watcher.checkPane runs once", async (ctx) => {
      await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      return ctx;
    }],
    then: ["one Discord post containing all 3 items, no duplicates", (ctx) => {
      // Filter to non-context-footer messages (footer is "_context: …_").
      const contentSends = ctx.discord.sends.filter(
        (s) => typeof s.payload === "string"
          ? !/^_context:/.test(s.payload)
          : !/^_context:/.test(s.payload?.content || ""),
      );
      expect(contentSends.length).toBe(1);
      const text = typeof contentSends[0].payload === "string"
        ? contentSends[0].payload
        : contentSends[0].payload.content;
      expect(text).toContain("Innan jag skriver");
      expect(text).toContain("Bash");
      expect(text).toContain("cat wrangler.toml");
      expect(text).toContain("ls src/");
      expect(text).toContain("Sparat planen");
      ctx.cleanup();
    }],
  });
});

feature("watcher: race-resilient against stampMs advancing past new endMs", () => {
  unit("new turn with endMs < channel_last_mirror_ts is still posted", {
    given: ["a jsonl with already-posted turn1 + new turn2; stampMs ahead", () => {
      const turn1Ts = "2026-04-30T20:00:00.000Z";
      const turn1AsstTs = "2026-04-30T20:00:01.000Z";
      const turn2Ts = "2026-04-30T20:00:02.000Z";
      const turn2AsstTs = "2026-04-30T20:00:03.000Z";

      const lines = [
        userTurn("first", turn1Ts),
        assistantText("turn1 reply", turn1AsstTs, "end_turn"),
        userTurn("second", turn2Ts),
        assistantText("turn2 reply", turn2AsstTs, "end_turn"),
      ];

      // Simulate: turn1 already posted (lastPostedMs = turn1's endMs).
      // Then watcher's own multi-chunk send finished at "now" — far AFTER
      // turn2's events landed in jsonl. stampChannelMirror reflects that.
      const turn1EndMs = new Date(turn1AsstTs).getTime();
      const stampInFuture = new Date(turn2AsstTs).getTime() + 60_000; // 60s later

      const ctx = setupWatcher({
        jsonlLines: lines,
        stateInitial: {
          watcher_last_posted_ts: { "ch-test": turn1EndMs },
          channel_last_mirror_ts: {
            "ch-test": new Date(stampInFuture).toISOString(),
          },
        },
      });
      return ctx;
    }],
    when: ["watcher.checkPane runs", async (ctx) => {
      await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      return ctx;
    }],
    then: ["turn2's reply was posted, not skipped by stampMs filter", (ctx) => {
      const contentSends = ctx.discord.sends.filter(
        (s) => typeof s.payload === "string"
          ? !/^_context:/.test(s.payload)
          : !/^_context:/.test(s.payload?.content || ""),
      );
      expect(contentSends.length).toBe(1);
      const text = typeof contentSends[0].payload === "string"
        ? contentSends[0].payload
        : contentSends[0].payload.content;
      expect(text).toContain("turn2 reply");
      ctx.cleanup();
    }],
  });
});

feature("watcher: grace-fire is suppressed while jsonl is being actively written", () => {
  unit("turn with stale endMs but FRESH file mtime (tool_results landing) does not post", {
    given: ["a jsonl: assistant→tool_use, then tool_result bumps mtime", () => {
      // Turn started, assistant fired tool_use 10s ago.
      // tool_result arrived just now → mtime is fresh.
      // No terminal stop_reason yet (agent still waiting for next assistant block).
      const tenSecAgo = new Date(Date.now() - 10_000).toISOString();
      const userTs = new Date(Date.now() - 12_000).toISOString();

      const lines = [
        userTurn("run a command", userTs),
        assistantTool("Bash", { command: "long-running-script" }, tenSecAgo),
        // tool_result not yet recorded in jsonl events that watcher reads as
        // assistant items — but the FILE itself gets a fresh mtime when
        // any append happens. Force mtime to NOW.
        toolResult("output", new Date(Date.now() - 500).toISOString()),
      ];

      const ctx = setupWatcher({
        jsonlLines: lines,
        stateInitial: {
          watcher_last_posted_ts: { "ch-test": new Date(userTs).getTime() - 1 },
        },
      });
      // Force file mtime to be very fresh (last 0.5s).
      const now = Date.now() / 1000;
      utimesSync(ctx.jsonlPath, now, now);
      return ctx;
    }],
    when: ["watcher.checkPane runs", async (ctx) => {
      await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      return ctx;
    }],
    then: ["no post yet — turn still active because file mtime is fresh", (ctx) => {
      const contentSends = ctx.discord.sends.filter(
        (s) => typeof s.payload === "string"
          ? !/^_context:/.test(s.payload)
          : !/^_context:/.test(s.payload?.content || ""),
      );
      expect(contentSends.length).toBe(0);
      ctx.cleanup();
    }],
  });
});
