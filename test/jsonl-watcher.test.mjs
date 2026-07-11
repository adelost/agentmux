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

function mkDiscord({ paceMs = 0, failSends = false } = {}) {
  const sends = [];
  const discord = {
    sends,
    failSends,
    send: vi.fn(async (channelId, payload) => {
      if (discord.failSends) throw new Error("discord unavailable");
      sends.push({ channelId, payload, t: Date.now() });
      if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
      return true;
    }),
    sendTyping: vi.fn(async () => {}),
  };
  return discord;
}

/**
 * Codex variant of setupWatcher. Writes a rollout file under
 * ~/.codex/sessions/YYYY/MM/DD/ with session_meta.cwd === paneDir, so
 * the Codex reader's latestSessionFor() picks it up. Mirrors the Claude
 * helper's contract so tests stay parallel-readable.
 */
function setupCodexWatcher({ codexEvents = [], stateInitial = {} } = {}) {
  const fakeHome = mkdtempSync(join(tmpdir(), "agentmux-watcher-codex-test-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;

  const agentRootDir = join(fakeHome, "workspace");
  mkdirSync(agentRootDir, { recursive: true });
  writeFileSync(join(agentRootDir, ".gitignore"), ".agents/\n");
  const paneDirPath = join(agentRootDir, ".agents", "0");
  mkdirSync(paneDirPath, { recursive: true });

  const sessionDir = join(fakeHome, ".codex", "sessions", "2026", "05", "10");
  mkdirSync(sessionDir, { recursive: true });
  const rolloutPath = join(sessionDir, "rollout-2026-05-10T00-00-00-test.jsonl");
  // Inject session_meta with cwd matching paneDir so latestSessionFor matches.
  const events = [{ type: "session_meta", payload: { cwd: paneDirPath } }, ...codexEvents];
  writeFileSync(rolloutPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const agentsYamlPath = join(fakeHome, "agents.yaml");
  writeFileSync(agentsYamlPath, [
    "testagent:",
    `  dir: ${agentRootDir}`,
    "  panes:",
    "    - cmd: codex resume --last --dangerously-bypass-approvals-and-sandbox",
    "  discord:",
    "    \"ch-codex\": 0",
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
    rolloutPath,
    agentRootDir,
    cleanup: () => {
      watcher.stop();
      process.env.HOME = origHome;
      rmSync(fakeHome, { recursive: true, force: true });
    },
  };
}

function setupWatcher({ jsonlLines = [], stateInitial = {}, discordOptions = {} } = {}) {
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
  const discord = mkDiscord(discordOptions);
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

feature("watcher: narrative with multiple images", () => {
  unit("keeps text on the first post and splits attachments at Discord's limit", {
    given: ["a final answer with 12 valid image markers", () => {
      const userTs = "2026-04-30T20:10:00.000Z";
      const ctx = setupWatcher({
        stateInitial: {
          watcher_last_posted_ts: { "ch-test": new Date(userTs).getTime() - 1 },
        },
      });
      const paths = Array.from({ length: 12 }, (_, i) => {
        const path = join(ctx.agentRootDir, `proof-${i}.png`);
        writeFileSync(path, "not-empty");
        return path;
      });
      ctx.appendJsonl([
        userTurn("show proof", userTs),
        assistantText([
          "All checks passed. Here are the screenshots.",
          ...paths.map((path) => `[image: ${path}]`),
        ].join("\n"), "2026-04-30T20:10:01.000Z", "end_turn"),
      ]);
      return ctx;
    }],
    when: ["watcher.checkPane posts the completed turn", async (ctx) => {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const pending = ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      await vi.runAllTimersAsync();
      await pending;
      vi.useRealTimers();
      return ctx;
    }],
    then: ["the summary accompanies 10 images and the remaining 2 follow separately", (ctx) => {
      expect(ctx.discord.sends).toHaveLength(2);
      expect(ctx.discord.sends[0].payload.content).toContain("All checks passed");
      expect(ctx.discord.sends[0].payload.files).toHaveLength(10);
      expect(ctx.discord.sends[1].payload.content).toBeUndefined();
      expect(ctx.discord.sends[1].payload.files).toHaveLength(2);
      ctx.cleanup();
    }],
  });
});

feature("watcher: claude compaction visibility", () => {
  unit("announces a new compact summary exactly once", {
    given: ["a Claude compact-summary row on an initialized channel", () => setupWatcher({
      jsonlLines: [{
        type: "user",
        uuid: "compact-summary-1",
        timestamp: "2026-04-30T20:20:00.000Z",
        isCompactSummary: true,
        message: { role: "user", content: "This session is being continued from a compact summary." },
      }],
      stateInitial: {
        watcher_compaction_ids: { "ch-test": [] },
      },
    })],
    when: ["watcher.checkPane observes the unchanged session twice", async (ctx) => {
      await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      return ctx;
    }],
    then: ["one completion notice is posted", (ctx) => {
      expect(ctx.discord.sends).toHaveLength(1);
      expect(ctx.discord.sends[0].payload).toBe(
        "Context compacted for **testagent:0**. Work continues from the summary.",
      );
      ctx.cleanup();
    }],
  });
});

feature("watcher: Codex background polling stays out of Discord", () => {
  unit("wait calls are suppressed while adjacent user-facing text is posted", {
    given: ["a Codex turn containing text and repeated wait function calls", () => {
      const ts = "2026-05-10T08:00:00.000Z";
      return setupCodexWatcher({
        codexEvents: [
          { type: "event_msg", timestamp: ts, payload: { type: "task_started", turn_id: "T1" } },
          { type: "event_msg", timestamp: ts, payload: { type: "user_message", message: "run tests" } },
          { type: "response_item", timestamp: "2026-05-10T08:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Tests are running." }] } },
          { type: "response_item", timestamp: "2026-05-10T08:00:02.000Z", payload: { type: "function_call", name: "wait", arguments: JSON.stringify({ cell_id: "264", yield_time_ms: 30000 }) } },
          { type: "response_item", timestamp: "2026-05-10T08:00:03.000Z", payload: { type: "function_call", name: "wait", arguments: JSON.stringify({ cell_id: "299", yield_time_ms: 30000 }) } },
          { type: "event_msg", timestamp: "2026-05-10T08:00:04.000Z", payload: { type: "task_complete", turn_id: "T1" } },
        ],
        stateInitial: { watcher_last_posted_ts: { "ch-codex": new Date(ts).getTime() - 1 } },
      });
    }],
    when: ["the watcher mirrors the turn", async (ctx) => {
      await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      return ctx;
    }],
    then: ["only the user-facing text appears", (ctx) => {
      const bodies = ctx.discord.sends.map((s) => typeof s.payload === "string" ? s.payload : s.payload?.content || "");
      expect(bodies.some((body) => body.includes("Tests are running."))).toBe(true);
      expect(bodies.some((body) => body.includes("wait cell_id="))).toBe(false);
      ctx.cleanup();
    }],
  });

  unit("a wait-only incremental update posts neither tool noise nor a context footer", {
    given: ["a complete Codex turn containing only a wait call", () => {
      const ts = "2026-05-10T08:10:00.000Z";
      return setupCodexWatcher({
        codexEvents: [
          { type: "event_msg", timestamp: ts, payload: { type: "task_started", turn_id: "T2" } },
          { type: "event_msg", timestamp: ts, payload: { type: "user_message", message: "continue waiting" } },
          { type: "response_item", timestamp: "2026-05-10T08:10:01.000Z", payload: { type: "function_call", name: "wait", arguments: JSON.stringify({ cell_id: "521", yield_time_ms: 20000 }) } },
          { type: "event_msg", timestamp: "2026-05-10T08:10:02.000Z", payload: { type: "task_complete", turn_id: "T2" } },
        ],
        stateInitial: { watcher_last_posted_ts: { "ch-codex": new Date(ts).getTime() - 1 } },
      });
    }],
    when: ["the watcher mirrors the turn", async (ctx) => {
      await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      return ctx;
    }],
    then: ["Discord remains silent", (ctx) => {
      expect(ctx.discord.sends).toHaveLength(0);
      ctx.cleanup();
    }],
  });
});

feature("watcher: context footer follows narrative output, not raw tools", () => {
  unit("a tool-only update stays transparent without repeating model context", {
    given: ["a complete Codex tool-only turn with available context", () => {
      const ts = "2026-05-10T08:30:00.000Z";
      const ctx = setupCodexWatcher({
        codexEvents: [
          { type: "event_msg", timestamp: ts, payload: { type: "task_started", turn_id: "T3" } },
          { type: "event_msg", timestamp: ts, payload: { type: "user_message", message: "inspect" } },
          { type: "response_item", timestamp: "2026-05-10T08:30:01.000Z", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "git status --short" }) } },
          { type: "event_msg", timestamp: "2026-05-10T08:30:02.000Z", payload: { type: "task_complete", turn_id: "T3" } },
        ],
        stateInitial: { watcher_last_posted_ts: { "ch-codex": new Date(ts).getTime() - 1 } },
      });
      ctx.agent.getContextPercent.mockReturnValue({ percent: 42, tokens: 120000, model: "test" });
      return ctx;
    }],
    when: ["the watcher mirrors it", async (ctx) => {
      await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      return ctx;
    }],
    then: ["the command is visible but no context footer is posted", (ctx) => {
      const bodies = ctx.discord.sends.map((s) => typeof s.payload === "string" ? s.payload : s.payload?.content || "");
      expect(bodies.some((body) => body.includes("git status --short"))).toBe(true);
      expect(bodies.some((body) => body.includes("context: 42%"))).toBe(false);
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

feature("watcher: unchanged jsonl is skipped before tail-read", () => {
  unit("a second check of the same complete file does no mirror work", {
    given: ["a complete jsonl turn that is ready to post", () => {
      const userTs = "2026-04-30T20:10:00.000Z";
      const ctx = setupWatcher({
        jsonlLines: [
          userTurn("answer once", userTs),
          assistantText("one reply", "2026-04-30T20:10:01.000Z", "end_turn"),
        ],
        stateInitial: {
          watcher_last_posted_ts: { "ch-test": new Date(userTs).getTime() - 1 },
        },
      });
      return ctx;
    }],
    when: ["watcher.checkPane runs twice without any file append", async (ctx) => {
      const first = await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      const second = await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      return { ...ctx, first, second };
    }],
    then: ["the second check is skipped as unchanged", (ctx) => {
      expect(ctx.first?.actions).toBe(1);
      expect(ctx.second).toEqual({ skipped: "unchanged" });
      const contentSends = ctx.discord.sends.filter(
        (s) => typeof s.payload === "string"
          ? !/^_context:/.test(s.payload)
          : !/^_context:/.test(s.payload?.content || ""),
      );
      expect(contentSends.length).toBe(1);
      ctx.cleanup();
    }],
  });

  unit("an unchanged incomplete turn is read again when grace becomes due", {
    given: ["a fresh incomplete turn with unposted content", () => {
      vi.useFakeTimers();
      const baseMs = new Date("2026-04-30T20:20:20.000Z").getTime();
      vi.setSystemTime(baseMs);

      const userTs = new Date(baseMs - 12_000).toISOString();
      const assistantTs = new Date(baseMs - 10_000).toISOString();
      const ctx = setupWatcher({
        jsonlLines: [
          userTurn("partial", userTs),
          assistantTool("Bash", { command: "still-running" }, assistantTs),
        ],
        stateInitial: {
          watcher_last_posted_ts: { "ch-test": new Date(userTs).getTime() - 1 },
        },
      });
      utimesSync(ctx.jsonlPath, baseMs / 1000, baseMs / 1000);
      return { ...ctx, baseMs };
    }],
    when: ["watcher.checkPane runs before and after the grace deadline", async (ctx) => {
      const first = await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      const second = await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      vi.setSystemTime(ctx.baseMs + 6_000);
      const third = await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      return { ...ctx, first, second, third };
    }],
    then: ["it skips while fresh, then posts by grace from the same file stamp", (ctx) => {
      try {
        expect(ctx.first?.actions).toBe(0);
        expect(ctx.second).toEqual({ skipped: "unchanged" });
        expect(ctx.third?.actions).toBe(1);
        const contentSends = ctx.discord.sends.filter(
          (s) => typeof s.payload === "string"
            ? !/^_context:/.test(s.payload)
            : !/^_context:/.test(s.payload?.content || ""),
        );
        expect(contentSends.length).toBe(1);
        expect(
          typeof contentSends[0].payload === "string"
            ? contentSends[0].payload
            : contentSends[0].payload.content,
        ).toContain("still-running");
      } finally {
        ctx.cleanup();
        vi.useRealTimers();
      }
    }],
  });
});

feature("watcher: continuation after intermediate post (the 1.16.46 regression)", () => {
  unit("if a turn was partially posted, the FINAL items still land when stop_reason hits", {
    given: ["a turn with 2 tool-uses already posted, then final text + end_turn appended", () => {
      // Real-world scenario from skybar-0 22:22:
      //   - User prompted, agent fired 3 Bash tool-uses
      //   - Watcher posted those (intermediate, grace fired during quiet gap)
      //   - 2m 19s later, agent wrote final summary text + stop_reason=end_turn
      //   - Pre-fix: track-once blocked the final text, never posted.
      //   - Post-fix (diff-posts): final text posts, no duplicate of the
      //     2 already-posted Bash items.
      const userTs = "2026-04-30T22:22:00.000Z";

      const lines = [
        userTurn("find my account", userTs),
        assistantTool("Bash", { command: "grep -r account /memory" }, "2026-04-30T22:22:01.000Z"),
        assistantTool("Bash", { command: "ls config" }, "2026-04-30T22:22:02.000Z"),
        // First post happened — watcher recorded postedCount=2 for this turn.
        // Now the agent comes back and finishes:
        assistantText("Hittat — kontot ligger på pr@example.se.", "2026-04-30T22:24:30.000Z", "end_turn"),
      ];

      const ctx = setupWatcher({
        jsonlLines: lines,
        stateInitial: {
          watcher_last_posted_ts: {
            "ch-test": new Date("2026-04-30T22:22:02.000Z").getTime(),
          },
          // Watcher already posted the 2 Bash tool-uses for this turn. Dedupe is
          // now keyed on stable item ids (`${uuid}:${blockIndex}`), not a count,
          // so seed the two tool-use ids as already-posted.
          watcher_posted_item_ids: {
            "ch-test": [
              "at-2026-04-30T22:22:01.000Z:0",
              "at-2026-04-30T22:22:02.000Z:0",
            ],
          },
        },
      });
      return ctx;
    }],
    when: ["watcher.checkPane runs after the final text + stop_reason landed", async (ctx) => {
      await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      return ctx;
    }],
    then: ["final text was posted (1 post), and it does NOT contain the already-posted Bash items", (ctx) => {
      const contentSends = ctx.discord.sends.filter(
        (s) => typeof s.payload === "string"
          ? !/^_context:/.test(s.payload)
          : !/^_context:/.test(s.payload?.content || ""),
      );
      expect(contentSends.length).toBe(1);
      const text = typeof contentSends[0].payload === "string"
        ? contentSends[0].payload
        : contentSends[0].payload.content;
      expect(text).toContain("Hittat — kontot");
      // Diff-posts: must NOT contain the already-posted tool-uses
      expect(text).not.toContain("grep -r account /memory");
      expect(text).not.toContain("ls config");
      ctx.cleanup();
    }],
  });
});

feature("watcher: Discord failure is bounded by retry state", () => {
  unit("failed main post keeps checkpoint unchanged and suppresses immediate retry", {
    given: ["a complete turn and a Discord sink that fails sends", () => {
      const userTs = "2026-04-30T23:00:00.000Z";
      const initialCheckpoint = new Date(userTs).getTime() - 1;
      const ctx = setupWatcher({
        jsonlLines: [
          userTurn("answer this", userTs),
          assistantText("first answer", "2026-04-30T23:00:01.000Z", "end_turn"),
        ],
        stateInitial: {
          watcher_last_posted_ts: { "ch-test": initialCheckpoint },
        },
        discordOptions: { failSends: true },
      });
      return { ...ctx, initialCheckpoint };
    }],
    when: ["checkPane runs once, then an immediate second signal arrives", async (ctx) => {
      await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      const sendsAfterFailure = ctx.discord.send.mock.calls.length;
      ctx.discord.failSends = false;
      await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      return { ...ctx, sendsAfterFailure };
    }],
    then: ["checkpoint stays put, retryUntil is set, and the second signal does not resend", (ctx) => {
      expect(ctx.sendsAfterFailure).toBe(1);
      expect(ctx.discord.send.mock.calls.length).toBe(1);
      expect(ctx.state._data.watcher_last_posted_ts["ch-test"]).toBe(ctx.initialCheckpoint);
      expect(ctx.state._data.watcher_retry_until_ts["ch-test"]).toBeGreaterThan(Date.now());
      ctx.cleanup();
    }],
  });
});

// --- Codex pane dispatch -------------------------------------------------

feature("watcher: codex pane reads from ~/.codex/sessions, not ~/.claude/projects", () => {
  unit("announces native codex compaction once without requiring an assistant turn", {
    given: ["an initialized channel sees a new compacted event", () => setupCodexWatcher({
      codexEvents: [
        { type: "compacted", timestamp: "2026-05-10T00:00:05.000Z", payload: {} },
      ],
      stateInitial: {
        watcher_compaction_ids: { "ch-codex": [] },
      },
    })],
    when: ["watcher.checkPane observes the same file twice", async (ctx) => {
      await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      return ctx;
    }],
    then: ["Discord receives one concise completion notice and no duplicate", (ctx) => {
      expect(ctx.discord.sends).toHaveLength(1);
      expect(ctx.discord.sends[0].payload).toBe(
        "Context compacted for **testagent:0**. Work continues from the summary.",
      );
      ctx.cleanup();
    }],
  });

  unit("first custom-tool-aware startup seeds history without replaying old calls", {
    given: ["a completed historical custom tool and no migration marker", () => {
      const oldStamp = Date.now() - 60_000;
      const oldIso = new Date(oldStamp).toISOString();
      return setupCodexWatcher({
        codexEvents: [
          { type: "event_msg", timestamp: oldIso, payload: { type: "task_started", turn_id: "M" } },
          { type: "event_msg", timestamp: oldIso, payload: { type: "user_message", message: "old work" } },
          { type: "response_item", timestamp: oldIso, payload: {
            type: "custom_tool_call",
            name: "exec",
            input: 'const r = await tools.exec_command({cmd:"amux ps",workdir:"/tmp"}); text(r.output);',
          } },
          { type: "event_msg", timestamp: oldIso, payload: { type: "task_complete", turn_id: "M" } },
        ],
        stateInitial: {
          watcher_last_posted_ts: { "ch-codex": oldStamp - 10_000 },
        },
      });
    }],
    when: ["the upgraded watcher performs its first audit", async (ctx) => {
      await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      return ctx;
    }],
    then: ["no historical tool flood occurs and migration is persisted", (ctx) => {
      expect(ctx.discord.sends).toHaveLength(0);
      expect(ctx.state._data.watcher_custom_tools_seeded["ch-codex"]).toBe(true);
      expect(ctx.state._data.watcher_posted_item_ids["ch-codex"]).toHaveLength(1);
      ctx.cleanup();
    }],
  });

  unit("posts assistant text from a complete codex turn", {
    given: ["agents.yaml has cmd: codex and a complete turn rollout exists", () => {
      const oldStamp = Date.now() - 60_000; // older than COMPLETION_GRACE_MS so post fires
      const oldIso = new Date(oldStamp).toISOString();
      const ctx = setupCodexWatcher({
        codexEvents: [
          { type: "event_msg", timestamp: oldIso, payload: { type: "task_started", turn_id: "X" } },
          { type: "event_msg", timestamp: oldIso, payload: { type: "user_message", message: "test prompt" } },
          { type: "response_item", timestamp: oldIso, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "codex reply text" }] } },
          { type: "event_msg", timestamp: oldIso, payload: { type: "task_complete", turn_id: "X" } },
        ],
        // Seed lastPosted so the watcher considers this turn fresh enough
        // to post (otherwise first-time channels just stamp + skip).
        stateInitial: {
          watcher_last_posted_ts: { "ch-codex": oldStamp - 10_000 },
          watcher_custom_tools_seeded: { "ch-codex": true },
        },
      });
      return ctx;
    }],
    when: ["watcher.checkPane runs", async (ctx) => {
      await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      return ctx;
    }],
    then: ["codex assistant text was posted to Discord", (ctx) => {
      const contentSends = ctx.discord.sends.filter(
        (s) => typeof s.payload === "string"
          ? !/^_context:/.test(s.payload)
          : !/^_context:/.test(s.payload?.content || ""),
      );
      expect(contentSends.length).toBeGreaterThan(0);
      const text = typeof contentSends[0].payload === "string"
        ? contentSends[0].payload
        : contentSends[0].payload.content;
      expect(text).toContain("codex reply text");
      ctx.cleanup();
    }],
  });

  unit("does not post anything when codex turn is still streaming (no task_complete)", {
    given: ["a fresh in-progress turn with no task_complete event", () => {
      const nowIso = new Date().toISOString();
      const ctx = setupCodexWatcher({
        codexEvents: [
          { type: "event_msg", timestamp: nowIso, payload: { type: "task_started", turn_id: "Y" } },
          { type: "event_msg", timestamp: nowIso, payload: { type: "user_message", message: "still going" } },
          { type: "response_item", timestamp: nowIso, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "partial..." }] } },
          // No task_complete on purpose
        ],
        stateInitial: {
          watcher_last_posted_ts: { "ch-codex": Date.now() - 60_000 },
        },
      });
      return ctx;
    }],
    when: ["watcher.checkPane runs immediately", async (ctx) => {
      await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      return ctx;
    }],
    then: ["nothing posted (turn still in flight, grace not elapsed)", (ctx) => {
      const contentSends = ctx.discord.sends.filter(
        (s) => typeof s.payload === "string"
          ? !/^_context:/.test(s.payload)
          : !/^_context:/.test(s.payload?.content || ""),
      );
      expect(contentSends.length).toBe(0);
      ctx.cleanup();
    }],
  });

  unit("posts the final text when several prompts and images occur in one codex task", {
    given: ["api:3-shaped rollout with busy follow-ups, compaction, then final text", () => {
      const oldStamp = Date.now() - 60_000;
      const iso = (offsetMs) => new Date(oldStamp + offsetMs).toISOString();
      return setupCodexWatcher({
        codexEvents: [
          { type: "event_msg", timestamp: iso(0), payload: { type: "task_started", turn_id: "X" } },
          { type: "turn_context", timestamp: iso(0), payload: { turn_id: "X" } },
          { type: "event_msg", timestamp: iso(1_000), payload: { type: "user_message", message: "initial task" } },
          { type: "response_item", timestamp: iso(2_000), payload: { type: "function_call", name: "wait", arguments: JSON.stringify({ cell_id: 1 }) } },
          { type: "event_msg", timestamp: iso(3_000), payload: { type: "user_message", message: "follow-up while busy" } },
          { type: "response_item", timestamp: iso(4_000), payload: { type: "function_call", name: "wait", arguments: JSON.stringify({ cell_id: 2 }) } },
          { type: "compacted", timestamp: iso(5_000), payload: {} },
          { type: "turn_context", timestamp: iso(5_000), payload: { turn_id: "X" } },
          { type: "response_item", timestamp: iso(5_500), payload: {
            type: "custom_tool_call",
            name: "exec",
            input: 'const r = await tools.exec_command({cmd:"amux ps",workdir:"/tmp"}); text(r.output);',
          } },
          { type: "response_item", timestamp: iso(6_000), payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "summary that must follow the uploaded images" }] } },
          { type: "event_msg", timestamp: iso(7_000), payload: { type: "task_complete", turn_id: "X" } },
        ],
        stateInitial: {
          watcher_last_posted_ts: { "ch-codex": oldStamp - 10_000 },
          watcher_custom_tools_seeded: { "ch-codex": true },
        },
      });
    }],
    when: ["watcher.checkPane runs while the rollout file itself is still fresh", async (ctx) => {
      await ctx.watcher.checkPane("testagent", 0, ctx.agentRootDir);
      return ctx;
    }],
    then: ["the final narrative reaches Discord and wait polling stays hidden", (ctx) => {
      const bodies = ctx.discord.sends.map((s) => typeof s.payload === "string" ? s.payload : s.payload?.content || "");
      expect(bodies.some((body) => body.includes("summary that must follow the uploaded images"))).toBe(true);
      expect(bodies.some((body) => body.includes("Bash amux ps"))).toBe(true);
      expect(bodies.some((body) => body.includes("wait cell_id"))).toBe(false);
      ctx.cleanup();
    }],
  });
});
